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

import {
    copy_dirty_entry,
    dirty_entries_equal,
    sanitized_wire_dirty_entry,
    type CsvDirtyEntry,
} from '../types';
import { hyperlinks_equal, type CellHyperlink } from '../cell-content';
import { is_plain_record } from '../plain-record';

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
        // Re-based on the plain text the save wrote. The kept side's runs come
        // along; the new base gets none — the saved string is all this path
        // knows, and a missing base side just means the next conflict check
        // compares plain text, which is what the host validates anyway. A
        // pending link dimension survives untouched: its baseLink may now be
        // stale (the save wrote an older link), which the next conflict check
        // surfaces rather than this path guessing.
        else {
            next.set(key, copy_dirty_entry(entry, { base: value, baseRuns: undefined }));
        }
    }
    return next;
}

/**
 * A resident cell's current hyperlink, addressed by canonical source row like
 * {@link GetCellRaw}: `null` for a cell that verifiably has none, `undefined`
 * for a row that is not resident. The `undefined` case is "unknown", never a
 * conflict — the same rule the raw reader follows, and deliberately unlike the
 * host's save-time validator, where an unobserved cell fails closed because
 * there the save is about to write it.
 */
export type GetCellLink = (
    source_row: number,
    col: number,
) => CellHyperlink | null | undefined;

export function is_entry_conflicted(
    key: string,
    entry: DirtyEntry,
    get_cell_raw: GetCellRaw,
    get_cell_link?: GetCellLink,
): boolean {
    // Base not yet captured (old-format restore on a non-resident page): can't
    // judge a conflict yet, so never flag.
    if (entry.base_pending) return false;
    const [r, c] = key.split(':').map(Number);
    const cur = get_cell_raw(r, c);
    // `undefined` means the page isn't resident — unknown, not a conflict.
    if (cur !== undefined && cur !== entry.base) return true;
    // A pending link edit conflicts on its own base, so a link-only entry —
    // whose text sides are equal by construction — is still checked. Without
    // this the cell is neither tinted nor reachable by "Discard conflicted",
    // and the staleness only surfaces when the host refuses the save.
    if (entry.link !== undefined && get_cell_link) {
        const current_link = get_cell_link(r, c);
        if (
            current_link !== undefined
            && !hyperlinks_equal(entry.baseLink ?? null, current_link)
        ) {
            return true;
        }
    }
    return false;
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
    install(identity: EditSessionIdentity, edits?: unknown): void;
    /** Reconcile an authoritative same-session refresh without notifying when its
     * map is already equal to the store's current contents. */
    reconcile(identity: EditSessionIdentity, edits?: unknown): void;
    /**
     * Re-stamp the session without touching contents, the pending-base flag, or
     * any listener. The stamp guards against a *stale writer* — a hook mounted
     * under a previous session — but it must never strand a *current* writer
     * against a lagging stamp. The host advances `csvEditSessionId` on every
     * applied snapshot while an install happens only for the current session, so
     * the id can legitimately move with no install behind it; attributing the
     * retained map to the newly adopted session is what preserves dirty state
     * across that transition without re-installing the store.
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
     * `collect_save_payload`.
     */
    replace(session_id: string | undefined, entries: unknown): void;
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
    /**
     * Apply a set of writes as ONE mutation: every key set or removed, one
     * notification, one snapshot the subscribers ever see.
     *
     * Exists for history replay, where a gesture spans many cells and the
     * intermediate states are not states the user ever had. Looping over
     * {@link commit} and {@link remove} would publish each one — a re-render, a
     * pendingEdits post and a host-side workspace-state write per cell of a
     * paste — and, worse, would leave a half-applied undo visible if anything
     * threw partway. The plan is decided before this is called (see
     * `history-replay-model.ts`); this only lands it.
     *
     * Later writes to one key win, matching the replay order the planner
     * produced: a cell a gesture touched twice ends where the last write puts it.
     */
    apply_writes(session_id: string | undefined, writes: Iterable<StoreWrite>): void;
    /**
     * Stage writes without publishing them, returning the swap that lands them.
     *
     * A replay plan spans worksheets, and a store owns exactly one — so a
     * cross-sheet undo needs several stores to move, and {@link apply_writes} on
     * each in turn would let a subscriber see the first sheet replayed while the
     * rest still hold the old state. That half-replayed gesture is precisely
     * what the plan/apply split exists to prevent, and it is what would be
     * published to the host as `pendingEdits`.
     *
     * So the caller stages every store, then calls every returned commit: each
     * swaps its own state without notifying, and the notifications go out only
     * once every swap has happened. Staging cannot fail, so a caller that has
     * staged them all can always finish.
     *
     * Returns `undefined` when the session moved on, exactly as the mutators
     * drop a stale write — a caller that gets one must abandon the whole plan
     * rather than commit the rest, since the gesture is no longer this session's
     * to replay.
     */
    stage_writes(
        session_id: string | undefined,
        writes: Iterable<StoreWrite>,
    ): StagedWrites | undefined;
}

/**
 * A store's next state, held back from its subscribers.
 *
 * `commit` swaps it in and answers whether anything actually moved; `notify`
 * publishes. Both are idempotent, so a caller may run the list twice without
 * double-notifying. Nothing here holds the store's listeners open — an abandoned
 * staging is simply dropped.
 */
export interface StagedWrites {
    /** Swap the staged state in without notifying. Answers whether it changed. */
    commit(): boolean;
    /** Notify this store's subscribers, once, if the commit changed anything. */
    notify(): void;
}

/**
 * One key's write: the entry to set, or `undefined` to remove the key.
 *
 * `DirtyEntry` rather than `CsvDirtyEntry`, so a write can carry `base_pending`.
 * A replay really can restore one — undoing the discard of a legacy edit whose
 * page was never resident puts back an entry whose base is still a placeholder —
 * and dropping the flag would promote that placeholder to observed content, so
 * conflict detection would compare against `''` and a save would be admitted
 * against a base the user never saw.
 */
export interface StoreWrite {
    readonly key: string;
    readonly entry: DirtyEntry | undefined;
}

interface NormalizedEdits {
    readonly entries: Map<string, DirtyEntry>;
    readonly pending_base: boolean;
}

function normalize(edits: unknown, allow_legacy_strings = true): NormalizedEdits | undefined {
    const entries = new Map<string, DirtyEntry>();
    if (edits === undefined) return { entries, pending_base: false };
    if (!is_plain_record(edits)) return undefined;

    let pending_base = false;
    for (const [key, value] of Object.entries(edits)) {
        if (typeof value === 'string') {
            if (!allow_legacy_strings) return undefined;
            // Old-format string entry: defer base capture uniformly. Baking in a
            // base now would risk a permanent false conflict when the page isn't
            // resident; resolve_pending_bases captures the true base once the page
            // loads.
            pending_base = true;
            entries.set(key, { value, base: '', base_pending: true });
            continue;
        }
        const sanitized = sanitized_wire_dirty_entry(value);
        if (!sanitized) return undefined;
        // A restored entry can itself still be pending (an install that
        // round-trips a not-yet-resolved map back through the prop). Only a real
        // boolean flag is retained; malformed optional metadata is quarantined.
        const base_pending = (value as { readonly base_pending?: unknown }).base_pending;
        if (typeof base_pending === 'boolean') {
            if (base_pending) pending_base = true;
            entries.set(key, { ...sanitized, base_pending });
            continue;
        }
        entries.set(key, sanitized);
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
        // Run sides included: a formatting-only recommit (same text, different
        // runs) must read as a change or the notification chain drops it.
        if (!dirty_entries_equal(before, entry)) return false;
        if (!!before.base_pending !== !!entry.base_pending) return false;
    }
    return true;
}

export function create_edit_session_store(
    identity?: EditSessionIdentity,
    edits?: unknown,
): EditSessionStore {
    let stamp: EditSessionIdentity | null = identity ?? null;
    let state = normalize(edits) ?? { entries: new Map<string, DirtyEntry>(), pending_base: false };
    const listeners = new Set<() => void>();

    const notify = (): void => {
        // Copy first: a listener may unsubscribe during the walk.
        for (const listener of [...listeners]) listener();
    };

    // The pending-base flag lives here rather than in the hook because a
    // generation remount no longer re-runs an install: a hook-local ref would
    // reset to false while base_pending entries remain, and both consequences
    // are silent — is_entry_conflicted would never flag a real external change,
    // and collect_save_payload (csv-save-model.ts) would refuse the save
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

    // The map a set of writes produces, built without publishing anything.
    const staged_state = (writes: Iterable<StoreWrite>): {
        entries: Map<string, DirtyEntry>;
        pending_base: boolean;
    } => {
        const entries = new Map(state.entries);
        for (const { key, entry } of writes) {
            if (entry === undefined) {
                entries.delete(key);
                continue;
            }
            // `copy_dirty_entry` rebuilds only the wire fields, so the flag is
            // carried across explicitly.
            const copied = copy_dirty_entry(entry);
            entries.set(key, entry.base_pending ? { ...copied, base_pending: true } : copied);
        }
        // Recomputed over the whole map, in BOTH directions. A replay adds and
        // removes, so it can clear the last pending entry — and, undoing a
        // discard, it can restore one where there was none, which the
        // narrowing-only recompute would leave reading false.
        let pending_base = false;
        for (const entry of entries.values()) {
            if (entry.base_pending) {
                pending_base = true;
                break;
            }
        }
        return { entries, pending_base };
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
            // guessing. A malformed candidate retains the current valid state but
            // still crosses that identity boundary and therefore still notifies.
            set_entries(
                next?.entries ?? state.entries,
                next?.pending_base ?? state.pending_base,
                true,
            );
        },
        reconcile: (next_identity, next_edits) => {
            stamp = next_identity;
            const next = normalize(next_edits);
            if (!next) return;
            set_entries(next.entries, next.pending_base);
        },
        adopt_session: (session_id) => {
            stamp = { session_id };
        },

        commit: (session_id, key, entry) => {
            if (!owns(session_id)) return;
            const next = new Map(state.entries);
            next.set(key, copy_dirty_entry(entry));
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
            const next = normalize(entries, false);
            if (!next) return;
            set_entries(next.entries, next.pending_base);
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
        stage_writes: (session_id, writes) => {
            if (!owns(session_id)) return undefined;
            const next = staged_state(writes);
            let changed = false;
            let committed = false;
            let notified = false;
            return {
                commit: () => {
                    if (committed) return changed;
                    committed = true;
                    // Re-checked at swap time, not just at staging: a staged plan
                    // is held across the staging of every other store, and an
                    // install could have crossed a hydration boundary in between.
                    if (!owns(session_id)) return false;
                    changed = next.pending_base !== state.pending_base
                        || !entries_equal(state.entries, next.entries);
                    if (changed) state = next;
                    return changed;
                },
                notify: () => {
                    if (notified || !changed) return;
                    notified = true;
                    notify();
                },
            };
        },
        apply_writes: (session_id, writes) => {
            if (!owns(session_id)) return;
            // Copied once, ahead of the walk, then handed to `set_entries` — which
            // drops it untouched if nothing moved, so a replay that lands on the
            // state already showing costs one map copy and no notification.
            const next = staged_state(writes);
            set_entries(next.entries, next.pending_base);
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
                        next.set(key, copy_dirty_entry(entry, {
                            base: cur,
                            baseRuns: undefined,
                        }));
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
