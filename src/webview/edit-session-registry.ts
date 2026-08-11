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
 * hoisting guarantee simple.
 *
 * The registry also owns which session its stores are stamped under, in two
 * deliberately separate steps that reproduce the single store's timing:
 *
 *  - {@link EditSessionRegistry.set_session} moves the identity *new* stores
 *    are created with, and is called synchronously wherever the session id ref
 *    moves — so a store built between that move and the commit is already
 *    fenced against the outgoing session's writers.
 *  - {@link EditSessionRegistry.adopt_session} re-stamps the *existing* stores,
 *    and runs from a layout effect at commit. The lag is the point: until the
 *    render under the new id commits, the on-screen grid is still the old
 *    session's, and its unmount-time folds are legitimate late writes that an
 *    eager re-stamp would silently drop.
 */

import {
    create_edit_session_store,
    type EditSessionStore,
} from './edit-session-store';

export interface EditSessionRegistry {
    /**
     * Move the session identity that new stores are stamped with.
     *
     * Identity only — existing stores keep their stamp until
     * {@link adopt_session}, for the reason given in the module comment.
     */
    set_session(session_id: string | undefined): void;
    /**
     * The store for one worksheet, created on first use.
     *
     * Created stamped with the current session for the same reason the single
     * store was: an unstamped store accepts a write from any writer, so leaving
     * the stamp to a later effect would make the session fence's soundness
     * depend on that effect having already run. A store created mid-session is
     * stamped with that session from its first render.
     */
    for_sheet(sheet_index: number): EditSessionStore;
    /** Re-stamp every existing store onto the current session. */
    adopt_session(): void;
}

export function create_edit_session_registry(): EditSessionRegistry {
    const stores = new Map<number, EditSessionStore>();
    let session_id: string | undefined;

    return {
        set_session: (next) => {
            session_id = next;
        },
        for_sheet: (sheet_index) => {
            const existing = stores.get(sheet_index);
            if (existing) return existing;
            const created = create_edit_session_store({ session_id });
            stores.set(sheet_index, created);
            return created;
        },
        adopt_session: () => {
            for (const store of stores.values()) {
                const stamp = store.identity();
                if (stamp && stamp.session_id === session_id) continue;
                store.adopt_session(session_id);
            }
        },
    };
}
