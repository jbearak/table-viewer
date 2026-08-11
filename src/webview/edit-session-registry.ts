/**
 * The edit-session stores of a workbook, one per worksheet.
 *
 * Editing is being widened from one worksheet to the whole workbook (#154). The
 * dirty map itself is already the right shape for that — its keys are
 * `sourceRow:sourceCol` within *one* sheet, and the durable leaf
 * (`PerFileState.pendingEdits`) is already a per-sheet array — so what a
 * workbook-wide session needs is not a different map but several of them, each
 * still in its own sheet's key space.
 *
 * That is this registry, and it is deliberately all it is. Keeping the split by
 * sheet *outside* {@link EditSessionStore} is what lets the store, the
 * `use_editing` hook and every `row:col` key stay exactly as they are: nothing
 * downstream has to learn which worksheet it is in, because a store never spans
 * more than one. Folding the sheet into the key space instead would have put a
 * sheet index into every conflict check, every save collector and every durable
 * key — the aliasing this shape avoids.
 *
 * Stores are created on demand and then kept: a store's lifetime is the edit
 * session, not the grid generation, so it has to survive the generation-keyed
 * `GridShell` remounts that a transform or refresh snapshot forces. Retaining a
 * sheet's store after its edits are gone costs an empty map and keeps the
 * hoisting guarantee simple; {@link EditSessionRegistry.reset} is the one way
 * they go away.
 */

import {
    create_edit_session_store,
    type EditSessionStore,
} from './edit-session-store';

export interface EditSessionRegistry {
    /**
     * The store for one worksheet, created on first use.
     *
     * Created stamped with `session_id` for the same reason the single store was:
     * an unstamped store accepts a write from any writer, so leaving the stamp to
     * a later effect would make the session fence's soundness depend on that
     * effect having already run. A store created mid-session is stamped with that
     * session from its first render.
     */
    for_sheet(sheet_index: number, session_id: string | undefined): EditSessionStore;
    /** The store for one worksheet if it has ever been asked for, else undefined. */
    peek(sheet_index: number): EditSessionStore | undefined;
    /** Every store that exists, by sheet index, ascending. */
    entries(): readonly (readonly [number, EditSessionStore])[];
    /** Sheets holding at least one dirty cell, ascending. */
    dirty_sheets(): readonly number[];
    /** Total dirty cells across every sheet. */
    size(): number;
    /** Re-stamp every store that is not already on `session_id`. */
    adopt_session(session_id: string | undefined): void;
    /** Drop every store. The next `for_sheet` builds a fresh one. */
    reset(): void;
}

export function create_edit_session_registry(): EditSessionRegistry {
    const stores = new Map<number, EditSessionStore>();

    // Ascending rather than in insertion order: a save writes several sheets and
    // the durable leaf is a positional array, so every consumer that walks these
    // wants them in sheet order. Sorting here keeps that from being restated —
    // and, for a save, keeps the order it writes sheets in independent of the
    // order the user happened to visit them.
    const sheets_ascending = (): number[] => [...stores.keys()].sort((a, b) => a - b);

    return {
        for_sheet: (sheet_index, session_id) => {
            const existing = stores.get(sheet_index);
            if (existing) return existing;
            const created = create_edit_session_store({ session_id });
            stores.set(sheet_index, created);
            return created;
        },
        peek: (sheet_index) => stores.get(sheet_index),
        entries: () => sheets_ascending().map(
            (sheet_index) => [sheet_index, stores.get(sheet_index)!] as const,
        ),
        dirty_sheets: () => sheets_ascending().filter(
            (sheet_index) => stores.get(sheet_index)!.size() > 0,
        ),
        size: () => {
            let total = 0;
            for (const store of stores.values()) total += store.size();
            return total;
        },
        adopt_session: (session_id) => {
            for (const store of stores.values()) {
                const stamp = store.identity();
                if (stamp && stamp.session_id === session_id) continue;
                store.adopt_session(session_id);
            }
        },
        reset: () => stores.clear(),
    };
}
