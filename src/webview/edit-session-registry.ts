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
    worksheet_identity,
    worksheet_target_lookup,
    type CsvDirtyMap,
    type WorksheetIdentityInput,
    type WorksheetTarget,
} from '../types';
import {
    create_edit_session_store,
    type EditSessionStore,
} from './edit-session-store';
import {
    collect_exact_dirty_edits,
    collect_save_edits,
} from './csv-save-model';

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
     * Follow live stores through a workbook change and retain selected removed
     * stores as parked session state. Returned stores are reattached by stable
     * worksheet identity and reported as locally authoritative for hydration.
     */
    reconcile_sheets(
        previous: readonly WorksheetIdentityInput[],
        next: readonly WorksheetIdentityInput[],
        retain_removed: (target: WorksheetTarget, store: EditSessionStore) => boolean,
    ): {
        readonly locallyRetainedIndices: ReadonlySet<number>;
        readonly retryPublications: readonly {
            target: WorksheetTarget;
            store: EditSessionStore;
        }[];
    };
    /** Drop detached stores when their session ends without replacing live stores. */
    retire_parked(): void;
    /** Every live and parked store with the target used for publication. */
    publication_entries(sheets: readonly WorksheetIdentityInput[]): IterableIterator<{
        target: WorksheetTarget;
        store: EditSessionStore;
        parked: boolean;
    }>;
    /** Whether any live or parked worksheet store contains dirty entries. */
    has_dirty_entries(): boolean;
    /**
     * Immutable snapshots of every dirty live and parked worksheet, ordered by
     * worksheet index. Parked collisions retain their insertion order.
     */
    collect_dirty_worksheets(sheets: readonly WorksheetIdentityInput[]): readonly {
        target: WorksheetTarget;
        edits: Readonly<Record<string, string>>;
        dirtyEdits: CsvDirtyMap;
        parked: boolean;
    }[];
    /**
     * A different document replaced this one: drop every store. An initial
     * snapshot owns the complete pending-edit projection, so any store that
     * survived it would be another file's edits waiting to leak through an
     * index collision.
     */
    replace_document(): void;
    /**
     * Empty every store's map, keeping the stores. A discard ends the
     * workbook-scoped session, so every sheet's local edits go at once — the
     * mounted grid's clear reaches only the sheet on screen.
     */
    clear_all(session_id: string | undefined): void;
    /**
     * Every store the registry holds, with the sheet index each sits at. The
     * close-flush boundary walks these: the session is workbook-scoped, so any
     * sheet's store may hold unpublished edits, not just the pointer sheet's.
     */
    entries(): IterableIterator<[number, EditSessionStore]>;
}

function target_for_sheet(
    sheetIndex: number,
    sheet: WorksheetIdentityInput,
): WorksheetTarget {
    const identity = worksheet_identity(sheet);
    return {
        sheetIndex,
        sheetName: identity.name,
        ...(identity.worksheetId !== undefined
            ? { worksheetId: identity.worksheetId }
            : {}),
    };
}

export function create_edit_session_registry(
    current_session_id: () => string | undefined,
): EditSessionRegistry {
    let stores = new Map<number, EditSessionStore>();
    const parked = new Map<EditSessionStore, {
        target: WorksheetTarget;
        store: EditSessionStore;
    }>();

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
        reconcile_sheets: (previous, next, retain_removed) => {
            const moved = new Map<number, EditSessionStore>();
            const locally_retained_indices = new Set<number>();
            const retry_publications: Array<{
                target: WorksheetTarget;
                store: EditSessionStore;
            }> = [];
            const next_index_for = worksheet_target_lookup(next);

            for (const [parked_store, entry] of parked) {
                const next_index = next_index_for(entry.target);
                if (next_index === undefined || moved.has(next_index)) {
                    retry_publications.push(entry);
                    continue;
                }
                parked.delete(parked_store);
                moved.set(next_index, entry.store);
                locally_retained_indices.add(next_index);
                retry_publications.push({
                    target: target_for_sheet(next_index, next[next_index]),
                    store: entry.store,
                });
            }
            for (const [previous_index, store] of stores) {
                const previous_sheet = previous[previous_index];
                if (!previous_sheet) continue;
                const target = target_for_sheet(previous_index, previous_sheet);
                const next_index = next_index_for(target);
                if (next_index !== undefined && !moved.has(next_index)) {
                    moved.set(next_index, store);
                    if (retain_removed(target, store)) {
                        locally_retained_indices.add(next_index);
                        retry_publications.push({
                            target: target_for_sheet(next_index, next[next_index]),
                            store,
                        });
                    }
                    continue;
                }
                if (!retain_removed(target, store)) continue;
                const entry = { target, store };
                parked.set(store, entry);
                retry_publications.push(entry);
            }
            stores = moved;
            return {
                locallyRetainedIndices: locally_retained_indices,
                retryPublications: retry_publications,
            };
        },
        retire_parked: () => {
            parked.clear();
        },
        publication_entries: function* (sheets) {
            for (const [sheet_index, store] of stores) {
                const sheet = sheets[sheet_index];
                if (!sheet) continue;
                yield {
                    target: target_for_sheet(sheet_index, sheet),
                    store,
                    parked: false,
                };
            }
            for (const entry of parked.values()) yield { ...entry, parked: true };
        },
        has_dirty_entries: () => {
            for (const store of stores.values()) {
                if (store.size() > 0) return true;
            }
            for (const { store } of parked.values()) {
                if (store.size() > 0) return true;
            }
            return false;
        },
        collect_dirty_worksheets: (sheets) => {
            const collected: Array<{
                target: WorksheetTarget;
                edits: Readonly<Record<string, string>>;
                dirtyEdits: CsvDirtyMap;
                parked: boolean;
                order: number;
            }> = [];
            let order = 0;
            const collect = (
                target: WorksheetTarget,
                store: EditSessionStore,
                is_parked: boolean,
            ): void => {
                const snapshot = store.snapshot();
                if (snapshot.size === 0) return;
                const dirty_edits = collect_exact_dirty_edits(snapshot, null);
                if (!dirty_edits) return;
                collected.push({
                    target: Object.freeze({ ...target }),
                    edits: Object.freeze(collect_save_edits(snapshot, null)),
                    dirtyEdits: dirty_edits,
                    parked: is_parked,
                    order: order++,
                });
            };

            for (const [sheet_index, store] of stores) {
                const sheet = sheets[sheet_index];
                if (!sheet) continue;
                collect(target_for_sheet(sheet_index, sheet), store, false);
            }
            for (const { target, store } of parked.values()) {
                collect(target, store, true);
            }
            collected.sort((left, right) =>
                left.target.sheetIndex - right.target.sheetIndex
                || Number(left.parked) - Number(right.parked)
                || left.order - right.order);
            return Object.freeze(collected.map(({ order: _order, ...entry }) =>
                Object.freeze(entry)));
        },
        replace_document: () => {
            stores.clear();
            parked.clear();
        },
        clear_all: (session_id) => {
            for (const store of stores.values()) store.clear(session_id);
            for (const { store } of parked.values()) store.clear(session_id);
        },
        entries: () => stores.entries(),
        adopt_session: () => {
            // Unconditional: the store's adopt_session is a bare stamp
            // assignment with no notification, so there is nothing to save by
            // skipping a store already on the current session.
            const session_id = current_session_id();
            for (const store of stores.values()) store.adopt_session(session_id);
            for (const { store } of parked.values()) store.adopt_session(session_id);
        },
    };
}
