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
 * The session identity itself stays with its one owner — App's session id ref,
 * read here through the injected `current_session_id` — so there is no second
 * copy to keep in lockstep. The two moments identity reaches a store are
 * deliberately different:
 *
 *  - A *new* store is stamped at creation from the getter, so a store built
 *    after the session id ref moves is already fenced against the outgoing
 *    session's writers, with no dependency on any effect having run.
 *  - *Existing* stores keep their stamp until {@link
 *    EditSessionRegistry.adopt_session}, which runs from a layout effect at
 *    commit. The lag is the point: until the render under the new id commits,
 *    the on-screen grid is still the old session's, and its unmount-time folds
 *    are legitimate late writes that an eager re-stamp would silently drop.
 */

import {
    create_edit_session_store,
    type EditSessionStore,
} from './edit-session-store';

export interface EditSessionRegistry {
    /**
     * The store for one worksheet, created on first use.
     *
     * Created stamped with the current session for the same reason the single
     * store was: an unstamped store accepts a write from any writer, so leaving
     * the stamp to a later effect would make the session fence's soundness
     * depend on that effect having already run.
     */
    for_sheet(sheet_index: number): EditSessionStore;
    /** Re-stamp every existing store onto the current session. */
    adopt_session(): void;
    /**
     * The session sheet pointer moved: carry its store to the new index and
     * drop every other store.
     *
     * This is the registry reproducing the single store it replaced. That
     * store was handed to whichever sheet the session pointer named, so when
     * a workbook edit outside this viewer reordered sheets, the edits
     * followed the pointer to the sheet's new index — and because it was
     * *replaced* wholesale at every hydration boundary, nothing stale could
     * outlive one. A registry that merely keeps stores by index broke both
     * halves: a reordered sheet's edits stayed at its old index (painting
     * them on whatever sheet now sits there), and another document's stores
     * survived an initial snapshot that replaced the file. Moving the
     * pointer's store and dropping the rest restores both, including on the
     * paths where no install follows — a refresh can advance the session id,
     * which makes the install conditional on it skip.
     *
     * The carried store is deliberately not re-created: its object identity
     * is what `install` notifies through and what the hydration boundary
     * reads its outgoing stamp from. When the pointer did not move this is
     * just the drop of every other store, which the file-replacement case
     * needs even at an unchanged index.
     */
    retarget(previous_sheet_index: number, next_sheet_index: number): void;
}

export function create_edit_session_registry(
    current_session_id: () => string | undefined,
): EditSessionRegistry {
    const stores = new Map<number, EditSessionStore>();

    return {
        for_sheet: (sheet_index) => {
            const existing = stores.get(sheet_index);
            if (existing) return existing;
            const created = create_edit_session_store({
                session_id: current_session_id(),
            });
            stores.set(sheet_index, created);
            return created;
        },
        retarget: (previous_sheet_index, next_sheet_index) => {
            const session_store = stores.get(previous_sheet_index);
            stores.clear();
            if (session_store) stores.set(next_sheet_index, session_store);
        },
        adopt_session: () => {
            // Unconditional: the store's adopt_session is a bare stamp
            // assignment with no notification, so there is nothing to save by
            // skipping a store already on the current session.
            const session_id = current_session_id();
            for (const store of stores.values()) {
                store.adopt_session(session_id);
            }
        },
    };
}
