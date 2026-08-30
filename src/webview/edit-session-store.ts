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
    dirty_entry_value_dimension_present,
    dirty_entry_with_observed_file_base,
    sanitized_wire_dirty_entry,
    type CsvDirtyEntry,
    type CsvObservedFileBase,
} from '../types';
import {
    rich_text_equal,
    type RichTextRun,
} from '../cell-content';
import { is_plain_record } from '../plain-record';
import { stage_mutation, type StagedMutation } from './staged-mutation';

export interface DirtyEntry extends CsvDirtyEntry {
    // When true, `base` has not yet been captured against a resident page (an
    // old-format string edit restored while its page was evicted). File-change
    // observation skips such entries until the page loads and captures `base`.
    base_pending?: boolean;
}

const DIRTY_ENTRY_INSERTION_ORDER = Symbol('dirty-entry-insertion-order');
type OrderedDirtyEntry = DirtyEntry & { [DIRTY_ENTRY_INSERTION_ORDER]?: number };

function dirty_entry_insertion_order(entry: DirtyEntry | undefined): number | undefined {
    return (entry as OrderedDirtyEntry | undefined)?.[DIRTY_ENTRY_INSERTION_ORDER];
}

function with_dirty_entry_insertion_order(entry: DirtyEntry, order: number): DirtyEntry {
    Object.defineProperty(entry, DIRTY_ENTRY_INSERTION_ORDER, { value: order });
    return entry;
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
 * is load-bearing: observation treats `undefined` as "unknown", never as a changed
 * value, so a non-resident row cannot produce a false notice. The hook never holds
 * the full grid, so editing scales to ~1M rows; the host performs the same check
 * for non-resident rows at save time.
 */
export type GetCellRaw = (source_row: number, col: number) => string | undefined;
export type GetCellBase = (
    source_row: number,
    col: number,
) => CsvObservedFileBase | undefined;

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
            next.set(key, copy_dirty_entry(entry, {
                base: value,
                baseRuns: undefined,
                observedBase: undefined,
            }));
        }
    }
    return next;
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

/** Formula-input delta carried with the ordinary store notification. */
export type EditSessionFormulaChange =
    | { readonly kind: 'none'; readonly key?: string }
    | {
        readonly kind: 'entry';
        readonly key: string;
        readonly previous?: EditSessionFormulaInput;
        readonly value?: EditSessionFormulaInput;
    }
    | { readonly kind: 'reset' };

export interface EditSessionFormulaInput {
    readonly value: string;
    readonly runs?: readonly RichTextRun[];
}

function formula_input(entry: DirtyEntry | undefined): EditSessionFormulaInput | undefined {
    if (!entry || !dirty_entry_value_dimension_present(entry)) return undefined;
    return {
        value: entry.value,
        ...(entry.valueRuns !== undefined ? { runs: entry.valueRuns.runs } : {}),
    };
}

function formula_inputs_equal(
    left: EditSessionFormulaInput | undefined,
    right: EditSessionFormulaInput | undefined,
): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left.value !== right.value) return false;
    if (left.runs === undefined || right.runs === undefined) {
        return left.runs === right.runs;
    }
    return rich_text_equal({ runs: left.runs }, { runs: right.runs });
}

export interface EditSessionStore {
    // reads
    /** Copy-on-write: identical reference until the next mutation, so it is a
     *  valid useSyncExternalStore getSnapshot. */
    snapshot(): ReadonlyMap<string, DirtyEntry>;
    subscribe(listener: (change: EditSessionFormulaChange) => void): () => void;
    /** The stamped session, or null for a store that has never been given one. */
    identity(): EditSessionIdentity | null;
    /** Single-key read for the Glide hot paths, which must not take the
     *  subscribed value. */
    get(key: string): DirtyEntry | undefined;
    /** Stable Map insertion rank, stored on the owned entry rather than in a parallel key map. */
    insertion_order(key: string): number | undefined;
    size(): number;
    /** Read imperatively, never subscribed: the base-capture effect's early
     *  return must cost one field read (get_cell_raw rebinds every page load). */
    has_pending_base(): boolean;
    /** Install a worksheet-envelope admission check for local write gestures. */
    set_write_validator(
        validator: (entries: ReadonlyMap<string, DirtyEntry>) => boolean,
        on_refused: () => void,
    ): () => void;

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
     * Filter in place by an arbitrary predicate. File-change callers decide
     * which entries survive from their host-observed bases before reaching the
     * store; this map does not infer file state or page residency.
     */
    retain(session_id: string | undefined, keep: (key: string, entry: DirtyEntry) => boolean): void;
    clear_saved(session_id: string | undefined, saved: Readonly<Record<string, string>>): void;
    /** Record the latest file side without replacing the edit's history base. */
    observe_file_bases(
        session_id: string | undefined,
        bases: ReadonlyMap<string, CsvObservedFileBase>,
    ): void;
    /** Capture true bases for base_pending entries whose page became resident.
     *  Notifies only when something changed. */
    resolve_pending_bases(session_id: string | undefined, get_cell_base: GetCellBase): void;
    /**
     * Stage a whole set of writes as ONE mutation, held back from the
     * subscribers until the caller says so: every key set or removed, one
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
     *
     * Held back rather than published outright because a replay plan spans
     * worksheets and a store owns exactly one — so a cross-sheet undo needs
     * several stores to move, and publishing each as it landed would let a
     * subscriber see the first sheet replayed while the rest still hold the old
     * state. That half-replayed gesture is precisely what the plan/apply split
     * exists to prevent, and it is what would be posted to the host as
     * `pendingEdits`.
     *
     * The protocol is three passes, and the order is the whole point: stage every
     * store, `valid()` every staging, and only then commit and notify. Checking
     * validity inside each commit would not do — the first store would already
     * have swapped by the time the third discovered its session had moved, and
     * that half-replayed state is observable through `snapshot()` and `get()`
     * whether or not anything has notified yet. A staging that is still valid
     * cannot fail to commit, so once the whole list validates the caller can
     * always finish.
     *
     * Returns `undefined` when the session moved on before staging, exactly as
     * the mutators drop a stale write.
     */
    stage_writes(
        session_id: string | undefined,
        writes: Iterable<StoreWrite>,
        /** The caller already validated the complete worksheet envelope. */
        envelope_prevalidated?: boolean,
    ): StagedWrites | undefined;
    /**
     * Stage emptying the whole map, held back exactly as {@link stage_writes} is.
     *
     * Exists for the discard, which is one transaction spanning every sheet's
     * store AND the history recording of what it threw away. {@link clear}
     * publishes outright, so a discard built on it would empty the first sheet
     * before the recording had been validated — and a recording refused for
     * exceeding the bounds would then leave the edits gone with no way back.
     *
     * Distinct from `stage_writes` over every key rather than sugar for it: a
     * workbook-wide discard would otherwise enumerate the whole map into a write
     * list, and the point of clearing is that the next state is known without
     * naming a single cell.
     */
    stage_clear(session_id: string | undefined): StagedWrites | undefined;
}

/**
 * A store's next state, held back from its subscribers.
 *
 * `valid()` asks whether this staging may still be committed: false once the
 * store has crossed a hydration boundary or been mutated by anything else since
 * it was staged. See {@link StagedMutation} for the protocol these participate
 * in: this store's writes and the history's recording of them stage, validate
 * and commit together, because they are one transaction.
 */
export type StagedWrites = StagedMutation;

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
    let next_entry_order = 0;
    const reset_entry_orders = (entries: Map<string, DirtyEntry>): void => {
        let order = 0;
        for (const entry of entries.values()) {
            with_dirty_entry_insertion_order(entry, order);
            order += 1;
        }
        // A value-equal reconcile keeps the existing map. Never reuse one of
        // its possibly gapped ranks if the freshly ranked candidate is dropped.
        next_entry_order = Math.max(next_entry_order, order);
    };
    const preserve_order_from = (
        entry: DirtyEntry,
        previous: DirtyEntry | undefined,
    ): DirtyEntry => {
        const order = dirty_entry_insertion_order(previous) ?? next_entry_order++;
        return with_dirty_entry_insertion_order(entry, order);
    };
    const preserve_entry_order = (key: string, entry: DirtyEntry): DirtyEntry =>
        preserve_order_from(entry, state.entries.get(key));
    reset_entry_orders(state.entries);
    let write_validator: {
        readonly validate: (entries: ReadonlyMap<string, DirtyEntry>) => boolean;
        readonly on_refused: () => void;
    } | undefined;
    const listeners = new Set<(change: EditSessionFormulaChange) => void>();
    const RESET_FORMULA_INPUTS = { kind: 'reset' } as const;

    const notify = (change: EditSessionFormulaChange = RESET_FORMULA_INPUTS): void => {
        // Copy first: a listener may unsubscribe during the walk.
        for (const listener of [...listeners]) listener(change);
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
        formula_change: EditSessionFormulaChange = RESET_FORMULA_INPUTS,
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
        notify(formula_change);
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
            entries.set(key, preserve_order_from(
                entry.base_pending ? { ...copied, base_pending: true } : copied,
                entries.get(key),
            ));
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
    const set_entries_recomputed = (
        entries: Map<string, DirtyEntry>,
        formula_change: EditSessionFormulaChange = RESET_FORMULA_INPUTS,
    ): void => {
        if (!state.pending_base) {
            set_entries(entries, false, false, formula_change);
            return;
        }
        let pending_base = false;
        for (const entry of entries.values()) {
            if (entry.base_pending) {
                pending_base = true;
                break;
            }
        }
        set_entries(entries, pending_base, false, formula_change);
    };

    return {
        snapshot: () => state.entries,
        subscribe: (listener: (change: EditSessionFormulaChange) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        identity: () => stamp,
        get: (key: string) => state.entries.get(key),
        insertion_order: (key: string) => dirty_entry_insertion_order(state.entries.get(key)),
        size: () => state.entries.size,
        has_pending_base: () => state.pending_base,
        set_write_validator: (validator, on_refused) => {
            const installed = { validate: validator, on_refused };
            write_validator = installed;
            return () => {
                if (write_validator === installed) write_validator = undefined;
            };
        },

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
            const next_entries = next?.entries ?? state.entries;
            if (next !== undefined) reset_entry_orders(next_entries);
            set_entries(
                next_entries,
                next?.pending_base ?? state.pending_base,
                true,
            );
        },
        reconcile: (next_identity, next_edits) => {
            stamp = next_identity;
            const next = normalize(next_edits);
            if (!next) return;
            reset_entry_orders(next.entries);
            set_entries(next.entries, next.pending_base);
        },
        adopt_session: (session_id) => {
            stamp = { session_id };
        },

        commit: (session_id, key, entry) => {
            if (!owns(session_id)) return;
            const previous = formula_input(state.entries.get(key));
            const copied = preserve_entry_order(key, copy_dirty_entry(entry));
            const value = formula_input(copied);
            const next = new Map(state.entries);
            next.set(key, copied);
            set_entries(next, state.pending_base, false, formula_inputs_equal(previous, value)
                ? { kind: 'none', key }
                : { kind: 'entry', key, previous, value });
        },
        remove: (session_id, key) => {
            if (!owns(session_id) || !state.entries.has(key)) return;
            const previous = formula_input(state.entries.get(key));
            const next = new Map(state.entries);
            next.delete(key);
            set_entries_recomputed(next, previous === undefined
                ? { kind: 'none' }
                : { kind: 'entry', key, previous });
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
            reset_entry_orders(next.entries);
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
            const next = clear_saved_dirty_entries(state.entries, saved);
            for (const [key, entry] of next) {
                if (dirty_entry_insertion_order(entry) === undefined) {
                    next.set(key, preserve_entry_order(key, entry));
                }
            }
            set_entries_recomputed(next);
        },
        observe_file_bases: (session_id, bases) => {
            if (!owns(session_id) || bases.size === 0) return;
            const next = new Map(state.entries);
            for (const [key, observed] of bases) {
                const entry = next.get(key);
                if (!entry || entry.base_pending) continue;
                next.set(key, preserve_entry_order(
                    key,
                    dirty_entry_with_observed_file_base(entry, observed),
                ));
            }
            // The pending value did not move, so formula inputs are unchanged.
            set_entries(next, state.pending_base, false, { kind: 'none' });
        },
        stage_writes: (session_id, writes, envelope_prevalidated = false) => {
            if (!owns(session_id)) return undefined;
            // The state staged against, so a store that moved for any reason —
            // an install, a keystroke, a save landing — invalidates the staging
            // rather than silently rebasing it onto a map it never saw.
            const staged_from = state;
            const next = staged_state(writes);
            if (!envelope_prevalidated
                && write_validator !== undefined
                && !write_validator.validate(next.entries)) {
                write_validator.on_refused();
                return undefined;
            }
            return stage_mutation(
                () => state === staged_from && owns(session_id),
                () => {
                    const changed = next.pending_base !== state.pending_base
                        || !entries_equal(state.entries, next.entries);
                    if (changed) state = next;
                    return changed;
                },
                () => notify(),
            );
        },
        stage_clear: (session_id) => {
            if (!owns(session_id)) return undefined;
            const staged_from = state;
            return stage_mutation(
                () => state === staged_from && owns(session_id),
                () => {
                    if (state.entries.size === 0 && !state.pending_base) return false;
                    state = { entries: new Map(), pending_base: false };
                    return true;
                },
                () => notify(),
            );
        },
        resolve_pending_bases: (session_id, get_cell_base) => {
            if (!owns(session_id)) return;
            let changed = false;
            let still_pending = false;
            const next = new Map<string, DirtyEntry>();
            for (const [key, entry] of state.entries) {
                if (entry.base_pending) {
                    const [r, c] = key.split(':').map(Number);
                    const cur = get_cell_base(r, c);
                    if (cur !== undefined) {
                        next.set(key, preserve_entry_order(key, copy_dirty_entry(entry, {
                            base: cur.value,
                            baseRuns: cur.runs,
                            // A legacy scalar recorded only text. When that
                            // text already equals the resident rich cell, the
                            // draft did not express a formatting change; copy
                            // the captured runs to both sides so save/review do
                            // not invent one.
                            valueRuns: entry.value === cur.value
                                ? cur.runs
                                : entry.valueRuns,
                            formattingKnown: true,
                        })));
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
