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
    dirty_entry_value_changed,
    worksheet_identity,
    worksheet_target_lookup,
    type CsvDirtyMap,
    type WorksheetIdentityInput,
    type WorksheetTarget,
} from '../types';
import {
    create_edit_session_store,
    type DirtyEntry,
    type EditSessionFormulaChange,
    type EditSessionFormulaInput,
    type EditSessionStore,
} from './edit-session-store';
import type { StagedMutation } from './staged-mutation';
import { collect_save_payload } from './csv-save-model';
import { parse_cell_key } from '../cell-key';
import { MAX_WORKBOOK_FORMULAS } from '../spreadsheet-safety';
import type { FormulaCalculationEdit } from '../formula-calculation';
import { rich_text_equal } from '../cell-content';
import { xlsx_edit_writes_formula } from '../xlsx-cell-value';

export interface EditSessionFormulaProjection {
    readonly edits: readonly FormulaCalculationEdit[];
    readonly coordinateRevision: number;
    readonly calculationRevision: number;
    readonly tooManyEdits: boolean;
    readonly hasFormulaEdits: boolean;
}

export interface EditSessionSaveWorksheet {
    target: WorksheetTarget;
    edits: Readonly<Record<string, string>>;
    dirtyEdits: CsvDirtyMap;
}

export type EditSessionSavePreflight =
    | {
        status: 'ready';
        worksheets: readonly EditSessionSaveWorksheet[];
    }
    | {
        status: 'blocked';
        reason: 'unresolvedBases' | 'parkedEdits';
        targets: readonly WorksheetTarget[];
    };

/**
 * A discard held back from every store's subscribers, with the overlays it will
 * remove.
 *
 * `worksheets` is in the shape `discard_history_source` consumes, and it is a
 * snapshot: the maps are the stores' own copy-on-write snapshots, taken in the
 * same call that staged the emptying, so the recorded action and the staged
 * state describe the same instant.
 */
export interface StagedDiscard {
    readonly mutations: readonly StagedMutation[];
    readonly worksheets: readonly {
        readonly target: WorksheetTarget;
        readonly entries: ReadonlyMap<string, DirtyEntry>;
    }[];
}

export interface EditSessionRegistry {
    /** Aggregate observable for value projections spanning every live sheet. */
    subscribe(listener: () => void): () => void;
    revision(): number;
    /** Incrementally maintained formula inputs; unchanged by style/link-only writes. */
    formula_projection(): EditSessionFormulaProjection;
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
     * Preflight an all-or-nothing workbook save. Every dirty live worksheet is
     * assembled once; any unresolved base or dirty parked store blocks the whole
     * operation rather than silently producing a partial save.
     */
    collect_dirty_worksheets(
        sheets: readonly WorksheetIdentityInput[],
    ): EditSessionSavePreflight;
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
     * Stage the same emptying, and hand back what is about to be thrown away.
     *
     * The snapshot and the staging are one call because they must describe ONE
     * state. Reading every map and then staging separately would leave a window
     * in which a keystroke landed: the recorded action would be missing that
     * cell, so undoing the discard would restore everything except the user's
     * last edit — and the store's own `valid()` cannot catch it, because the
     * staging would have been taken against the state that already included it.
     *
     * `undefined` when any store refuses to stage, which is a session that has
     * moved on. Nothing is staged in that case: a discard is one gesture, and
     * emptying the sheets that would still take it leaves half a session.
     *
     * Parked stores are included. Their edits are just as gone after a discard,
     * and a parked store holding entries is what blocks a save — so a discard
     * that skipped them would leave the block in place with nothing visible
     * causing it.
     */
    stage_discard(
        session_id: string | undefined,
        sheets: readonly WorksheetIdentityInput[],
    ): StagedDiscard | undefined;
    /**
     * Every store the registry holds, with the sheet index each sits at. The
     * close-flush boundary walks these: the session is workbook-scoped, so any
     * sheet's store may hold unpublished edits, not just the pointer sheet's.
     */
    entries(): IterableIterator<[number, EditSessionStore]>;
}

/**
 * A sheet index plus its identity, as the whole target a history change records.
 *
 * Exported because highlight capture needs exactly this and building it by
 * spreading a `WorksheetIdentity` is a trap: the identity's field is `name`,
 * the target's is `sheetName`, so a spread yields a target that resolves by
 * index alone — and an index silently names a different worksheet after a move.
 */
export function target_for_sheet(
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
    let revision = 0;
    const listeners = new Set<() => void>();
    const subscriptions = new Map<EditSessionStore, () => void>();
    let formula_edits: FormulaCalculationEdit[] = [];
    let formula_value_edit_count = 0;
    let formula_edit_count = 0;
    let formula_coordinate_revision = 0;
    let formula_calculation_revision = 0;
    let too_many_formula_edits = false;
    const publish = () => {
        revision += 1;
        for (const listener of listeners) listener();
    };

    const compare_formula_edits = (
        left: FormulaCalculationEdit,
        right: FormulaCalculationEdit,
    ): number => (left.sheetIndex - right.sheetIndex)
        || (left.row - right.row)
        || (left.column - right.column);
    const formula_edit_values_equal = (
        left: FormulaCalculationEdit,
        right: FormulaCalculationEdit,
    ): boolean => {
        if (left.value !== right.value || left.writesFormula !== right.writesFormula) return false;
        if (left.runs === undefined || right.runs === undefined) {
            return left.runs === right.runs;
        }
        return rich_text_equal({ runs: left.runs }, { runs: right.runs });
    };
    const formula_edit_position = (wanted: FormulaCalculationEdit): number => {
        let low = 0;
        let high = formula_edits.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (compare_formula_edits(formula_edits[middle], wanted) < 0) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const calculation_input = (input: EditSessionFormulaInput): EditSessionFormulaInput & {
        readonly writesFormula: boolean;
    } => {
        const runs = input.runs;
        const retained_runs = runs && runs.length > 0 ? runs : undefined;
        return {
            value: input.value,
            writesFormula: xlsx_edit_writes_formula(input.value, retained_runs),
            ...(retained_runs !== undefined ? { runs: retained_runs } : {}),
        };
    };
    const formula_input = (entry: DirtyEntry): ReturnType<typeof calculation_input> | undefined =>
        dirty_entry_value_changed(entry)
            ? calculation_input({
                value: entry.value,
                ...(entry.valueRuns !== undefined ? { runs: entry.valueRuns.runs } : {}),
            })
            : undefined;
    const current_formula_entries = (): FormulaCalculationEdit[] => {
        const next: FormulaCalculationEdit[] = [];
        formula_value_edit_count = 0;
        formula_edit_count = 0;
        for (const [sheetIndex, store] of stores) {
            for (const [key, entry] of store.snapshot()) {
                const input = formula_input(entry);
                if (input === undefined) continue;
                const cell = parse_cell_key(key);
                if (!cell) continue;
                formula_value_edit_count += 1;
                formula_edit_count += input.writesFormula ? 1 : 0;
                if (next.length >= MAX_WORKBOOK_FORMULAS) continue;
                next.push({
                    sheetIndex,
                    row: cell.sourceRow,
                    column: cell.sourceColumn,
                    value: input.value,
                    writesFormula: input.writesFormula,
                    ...(input.runs !== undefined ? { runs: input.runs } : {}),
                });
            }
        }
        next.sort(compare_formula_edits);
        return next;
    };
    const rebuild_formula_projection = (): void => {
        const previous = formula_edits;
        const previous_too_many = too_many_formula_edits;
        const next = current_formula_entries();
        too_many_formula_edits = formula_value_edit_count > MAX_WORKBOOK_FORMULAS;
        if (too_many_formula_edits) next.length = 0;
        formula_edits = next;

        const coordinates_equal = !previous_too_many && !too_many_formula_edits
            && previous.length === next.length
            && previous.every((edit, index) => compare_formula_edits(edit, next[index]) === 0);
        const calculations_equal = coordinates_equal
            && previous.every((edit, index) => formula_edit_values_equal(edit, next[index]));
        if (!coordinates_equal) formula_coordinate_revision += 1;
        if (!calculations_equal) formula_calculation_revision += 1;
    };
    const apply_formula_change = (
        sheetIndex: number,
        change: Extract<EditSessionFormulaChange, { kind: 'entry' }>,
    ): void => {
        const previous = change.previous === undefined
            ? undefined
            : calculation_input(change.previous);
        const value = change.value === undefined
            ? undefined
            : calculation_input(change.value);
        if (change.previous !== undefined) {
            formula_value_edit_count -= 1;
            formula_edit_count -= previous?.writesFormula ? 1 : 0;
        }
        if (change.value !== undefined) {
            formula_value_edit_count += 1;
            formula_edit_count += value?.writesFormula ? 1 : 0;
        }
        formula_calculation_revision += 1;
        if ((change.previous === undefined) !== (change.value === undefined)) {
            formula_coordinate_revision += 1;
        }

        if (too_many_formula_edits) {
            if (formula_value_edit_count <= MAX_WORKBOOK_FORMULAS) {
                rebuild_formula_projection();
            }
            return;
        }
        const cell = parse_cell_key(change.key);
        if (!cell) {
            rebuild_formula_projection();
            return;
        }
        const wanted: FormulaCalculationEdit = {
            sheetIndex,
            row: cell.sourceRow,
            column: cell.sourceColumn,
            value: value?.value ?? '',
            writesFormula: value?.writesFormula ?? false,
            ...(value?.runs !== undefined ? { runs: value.runs } : {}),
        };
        const position = formula_edit_position(wanted);
        const existing = formula_edits[position];
        const present = existing !== undefined && compare_formula_edits(existing, wanted) === 0;
        if (change.value === undefined) {
            if (present) {
                const next = formula_edits.slice();
                next.splice(position, 1);
                formula_edits = next;
            }
            return;
        }
        const next = formula_edits.slice();
        if (present) next[position] = wanted;
        else next.splice(position, 0, wanted);
        formula_edits = next;
        if (formula_edits.length > MAX_WORKBOOK_FORMULAS) {
            too_many_formula_edits = true;
            formula_edits = [];
        }
    };
    const watch = (store: EditSessionStore) => {
        if (subscriptions.has(store)) return;
        subscriptions.set(store, store.subscribe((change) => {
            if (change.kind === 'reset') rebuild_formula_projection();
            else if (change.kind === 'entry') {
                for (const [sheetIndex, candidate] of stores) {
                    if (candidate !== store) continue;
                    apply_formula_change(sheetIndex, change);
                    break;
                }
            }
            publish();
        }));
    };
    const unwatch_detached = () => {
        const retained = new Set(stores.values());
        for (const { store } of parked.values()) retained.add(store);
        for (const [store, unsubscribe] of subscriptions) {
            if (retained.has(store)) continue;
            unsubscribe();
            subscriptions.delete(store);
        }
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        revision: () => revision,
        formula_projection: () => ({
            edits: formula_edits,
            coordinateRevision: formula_coordinate_revision,
            calculationRevision: formula_calculation_revision,
            tooManyEdits: too_many_formula_edits,
            hasFormulaEdits: formula_edit_count > 0,
        }),
        for_sheet: (sheet_index) => {
            const existing = stores.get(sheet_index);
            if (existing) return existing;
            const created = create_edit_session_store({
                session_id: current_session_id(),
            });
            stores.set(sheet_index, created);
            watch(created);
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
            unwatch_detached();
            rebuild_formula_projection();
            publish();
            return {
                locallyRetainedIndices: locally_retained_indices,
                retryPublications: retry_publications,
            };
        },
        retire_parked: () => {
            parked.clear();
            unwatch_detached();
            publish();
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
            const worksheets: EditSessionSaveWorksheet[] = [];
            const unresolved_targets: WorksheetTarget[] = [];
            const parked_targets: WorksheetTarget[] = [];

            for (const [sheet_index, store] of stores) {
                const sheet = sheets[sheet_index];
                if (!sheet) continue;
                const snapshot = store.snapshot();
                if (snapshot.size === 0) continue;
                const target = Object.freeze(
                    target_for_sheet(sheet_index, sheet),
                );
                const payload = collect_save_payload(snapshot);
                if (payload.status === 'blocked') {
                    unresolved_targets.push(target);
                    continue;
                }
                worksheets.push(Object.freeze({
                    target,
                    edits: payload.edits,
                    dirtyEdits: payload.dirtyEdits,
                }));
            }
            for (const { target, store } of parked.values()) {
                if (store.size() === 0) continue;
                parked_targets.push(Object.freeze({ ...target }));
            }

            if (parked_targets.length > 0) {
                return Object.freeze({
                    status: 'blocked',
                    reason: 'parkedEdits',
                    targets: Object.freeze(parked_targets),
                });
            }
            if (unresolved_targets.length > 0) {
                return Object.freeze({
                    status: 'blocked',
                    reason: 'unresolvedBases',
                    targets: Object.freeze(unresolved_targets),
                });
            }
            worksheets.sort((left, right) =>
                left.target.sheetIndex - right.target.sheetIndex);
            return Object.freeze({
                status: 'ready',
                worksheets: Object.freeze(worksheets),
            });
        },
        replace_document: () => {
            stores.clear();
            parked.clear();
            unwatch_detached();
            rebuild_formula_projection();
            publish();
        },
        stage_discard: (session_id, sheets) => {
            const mutations: StagedMutation[] = [];
            const worksheets: {
                target: WorksheetTarget;
                entries: ReadonlyMap<string, DirtyEntry>;
            }[] = [];
            // Snapshot and stage in one step per store, so no window exists
            // between reading a map and fixing the state that map came from. A
            // `target` of undefined is a store whose sheet is gone from the
            // workbook: it still has to be emptied — a discard empties everything
            // — but its cells have no identity to be named by in history, so it
            // is staged without being captured.
            const stage = (
                store: EditSessionStore,
                target: WorksheetTarget | undefined,
            ): boolean => {
                const entries = store.snapshot();
                const staged = store.stage_clear(session_id);
                if (staged === undefined) return false;
                mutations.push(staged);
                if (target !== undefined && entries.size > 0) {
                    worksheets.push({ target, entries });
                }
                return true;
            };
            for (const [sheet_index, store] of stores) {
                const sheet = sheets[sheet_index];
                if (!stage(
                    store,
                    sheet === undefined ? undefined : target_for_sheet(sheet_index, sheet),
                )) return undefined;
            }
            for (const { target, store } of parked.values()) {
                if (!stage(store, target)) return undefined;
            }
            return { mutations, worksheets };
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
