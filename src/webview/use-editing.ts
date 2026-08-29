import { useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { read_overlay_editor_value } from './live-editor';
import {
    create_edit_session_store,
    type DirtyEntry,
    type EditSessionStore,
    type GetCellRaw,
    type StoreWrite,
} from './edit-session-store';
import {
    copy_dirty_entry,
    dirty_entry_base_formatting_unknown,
    dirty_entry_observed_base,
    dirty_entry_value_changed,
    dirty_entry_with_observed_file_base,
    make_dirty_entry,
    make_observed_file_base,
    type CsvDirtyEntry,
    type CsvObservedFileBase,
    type WorksheetTarget,
} from '../types';
import {
    build_cell_history_change,
    type PersistedCellHistoryState,
} from './history-capture-model';
import {
    absent_overlay,
    history_value,
    overlay_state_from_dirty_entry,
    type CellOverlayState,
    type ValueDimensionIntent,
} from './history-cell-state-model';
import type { HistoryChange } from './history-stack-model';
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
import { xlsx_edit_writes_formula } from '../xlsx-cell-value';

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
 * closes the open editor while preserving pending edits, and file-change tracking
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
     * edit text and file-side bases derive from the cell's effective rich
     * content, which the plain-text reader cannot carry. Same residency
     * contract as {@link GetCellRaw} (`null` = resident-but-blank,
     * `undefined` = not resident).
     */
    readonly get_cell?: (source_row: number, col: number) => EditableSourceCell | null | undefined;
    /**
     * Whether a gesture may start at all.
     *
     * Exists for the replay reservation: while an undo is in flight the document
     * is mid-transaction, and a keystroke landing in that window would be planned
     * against a state the replay is about to move — then either lost to the
     * replay's own writes or, worse, silently overwritten by them.
     *
     * Refusing the gesture is deliberately NOT the same as leaving edit mode or
     * releasing the session: the user stays exactly where they are, and the
     * keystroke is dropped like one arriving with no session at all. A replay that
     * ended edit mode to protect itself would lose the user's other unsaved work.
     */
    readonly gestures_admitted?: () => boolean;
    /**
     * Where edits are recorded, absent for a consumer with no workbook around it
     * — the hook's own tests, and GridShell before App wires one down. Those
     * edit exactly as before, unrecorded.
     *
     * One object rather than two optional fields because capture needs both
     * halves and neither is any use alone: the pairing is the type's to enforce,
     * not a runtime check's.
     */
    readonly capture?: HistoryCaptureOptions;
    /** Retarget formula source for the editor without changing disk-relative conflict bases. */
    readonly formula_edit_text?: (
        sourceRow: number,
        sourceColumn: number,
        text: string,
        afterOrder?: number,
    ) => string;
    /** One workbook-wide order for a formula edit gesture. */
    readonly next_value_edit_order?: () => number;
}

/** What capturing an edit into the workbook's history needs. */
export interface HistoryCaptureOptions {
    /**
     * Which sheet these edits belong to. Recorded on every history change, so
     * an undo can find its way back to the sheet the edit was made on — the
     * history is workbook-wide and its entries have to say where they landed.
     */
    readonly worksheet: WorksheetTarget;
    /** The workbook's history. */
    readonly history: HistoryStore;
}

/** One cell's new text, in source space. */
export interface CellValueEdit {
    readonly source_row: number;
    readonly source_col: number;
    readonly value: string;
    readonly editOrder?: number;
    readonly movedFrom?: {
        readonly source_row: number;
        readonly source_col: number;
    };
}

/**
 * A cell's persisted side, read once and answering for both consumers of it —
 * see {@link use_editing}'s `read_persisted_cell`.
 */
interface PersistedCellRead {
    readonly base: ParsedCellEdit;
    /** `undefined` when the cell's page is not resident. */
    readonly history: PersistedCellHistoryState | undefined;
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
 * A planned write from the entry it stores, tagged with the intent that made it.
 *
 * The overlay is derived by the one function that reads an entry as an overlay,
 * rather than re-assembled by hand at each return: what a planner uniquely knows
 * is the *intent* behind the ambiguous `{value: A, base: A, link}` shape, and the
 * intent is exactly what it passes.
 */
function planned(entry: DirtyEntry, intent: ValueDimensionIntent): PlannedOverlayWrite {
    return { entry, overlay: overlay_state_from_dirty_entry(entry, intent) };
}

/** Attach the current persisted side only when it differs from an entry's
 * original side, adapting the optional link field to the dimensions the entry
 * now carries. Text and hyperlink planners both use this so adding/removing a
 * link cannot leave an invalid observedBase shape. */
function with_current_file_side(
    entry: CsvDirtyEntry,
    current: ParsedCellEdit,
    current_link: CellHyperlink | null,
): CsvDirtyEntry {
    return dirty_entry_with_observed_file_base(entry, make_observed_file_base(
        current.text,
        current.rich,
        entry.link !== undefined ? current_link : undefined,
    ));
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
    persisted: ParsedCellEdit,
    persisted_link: CellHyperlink | null,
    persisted_formatting_known: boolean,
    syntax: EditSyntax,
    edit?: Pick<CellValueEdit, 'source_row' | 'source_col' | 'editOrder' | 'movedFrom'>,
): PlannedOverlayWrite {
    const parsed = parse_cell_edit(input, syntax);
    // A pending link change is its own dimension: a text revert must not
    // discard it, and a text commit must carry it forward.
    const link_dimension = before_entry?.link !== undefined
        ? { link: before_entry.link, baseLink: before_entry.baseLink ?? null }
        : undefined;
    const moved_from = edit?.movedFrom === undefined
        ? before_entry?.movedFrom
        : edit.editOrder === undefined ? before_entry?.movedFrom : {
            row: edit.movedFrom.source_row,
            col: edit.movedFrom.source_col,
            order: edit.editOrder,
            ...(before_entry?.movedFrom === undefined ? {} : {
                previous: [
                    ...(before_entry.movedFrom.previous ?? []),
                    {
                        sourceRow: before_entry.movedFrom.row,
                        sourceCol: before_entry.movedFrom.col,
                        destinationRow: edit.source_row,
                        destinationCol: edit.source_col,
                        order: before_entry.movedFrom.order,
                    },
                ],
            }),
        };
    const value_edit_order = edit?.editOrder ?? before_entry?.valueEditOrder;

    // Semantic comparison: retyping a bold cell's own `**markup**`, however
    // spelled, is a revert; deleting the `**` is an edit.
    if (cell_edits_equal(parsed, persisted)) {
        if (link_dimension === undefined && moved_from === undefined && value_edit_order === undefined) {
            return { entry: undefined, overlay: absent_overlay() };
        }
        // Text reverted, link still pending: the entry survives as link-only,
        // its value dimension back at the base — and `link-only` is exactly
        // what the overlay has to say, since the entry it writes is the
        // ambiguous `{value: A, base: A, link}` shape.
        return planned(with_current_file_side(
            make_dirty_entry(
                persisted.text, persisted.text, persisted.rich, persisted.rich,
                link_dimension?.link, link_dimension?.baseLink,
                undefined,
                undefined,
                undefined,
                undefined,
                moved_from,
                value_edit_order,
            ),
            persisted,
            persisted_link,
        ),
            link_dimension === undefined ? 'in-overlay' : 'link-only',
        );
    }

    // An older sparse entry has no formatting provenance. If the resident
    // cell still has its historical base text, enrich that base before applying
    // the new value. Unchanged resident styling then stays the original side,
    // while markup removed by this commit is still a pending formatting edit.
    const historical_base_formatting_known = before_entry !== undefined
        && (before_entry.baseRuns !== undefined
            || before_entry.formattingKnown === true);
    const can_enrich_legacy_base = before_entry !== undefined
        && !historical_base_formatting_known
        && persisted.text === before_entry.base
        && persisted_formatting_known;
    const original = before_entry === undefined
        ? persisted
        : {
            text: before_entry.base,
            rich: can_enrich_legacy_base ? persisted.rich : before_entry.baseRuns,
        };
    const formatting_known = (before_entry !== undefined
        && (historical_base_formatting_known || can_enrich_legacy_base))
        || (before_entry === undefined && persisted_formatting_known)
        ? true
        : undefined;
    // Explicit plain runs when the user stripped a styled base's markup — see
    // committed_value_runs.
    return planned(with_current_file_side(
        make_dirty_entry(
            parsed.text,
            original.text,
            committed_value_runs(parsed, persisted),
            original.rich,
            link_dimension?.link, link_dimension?.baseLink,
            undefined,
            cell_edits_equal(parsed, original) ? true : undefined,
            undefined,
            formatting_known,
            moved_from,
            value_edit_order,
        ),
        persisted,
        persisted_link,
    ),
        'in-overlay',
    );
}

/**
 * What a hyperlink commit should leave in the store.
 *
 * `persisted_link` is the cell's link on disk. The base recorded is the already
 * pending `baseLink` when there is one, never the pending value, so re-editing
 * one cell's link keeps a single honest file-side base.
 *
 * Whether the value dimension survives is read off `before_overlay`, never off
 * whether the entry's value differs from its base. Membership and semantic
 * inequality are different facts: `resolve_pending_bases` can leave a legacy
 * entry at `{value: A, base: A}` that is genuinely in the map — tinted,
 * persisted and saved — and a value/base comparison would call that cell
 * untouched, record a value dimension leaving the overlay that never entered
 * it, and drop the entry on a later link revert.
 */
function plan_hyperlink_write(
    before_entry: DirtyEntry | undefined,
    before_overlay: CellOverlayState,
    next: CellHyperlink | null,
    base: ParsedCellEdit,
    persisted_link: CellHyperlink | null,
): PlannedOverlayWrite {
    const base_link = before_entry?.link !== undefined
        ? before_entry.baseLink ?? null
        : persisted_link;
    // The value dimension's intent carries over from the entry being extended:
    // a cell whose value was never in the overlay keeps a link-only value
    // dimension as its link changes, so undo does not restore text it never
    // wrote.
    const value_intent: ValueDimensionIntent = before_overlay.kind === 'present'
        && before_overlay.value.kind === 'present'
        ? 'in-overlay'
        : 'link-only';
    const preserve_value_membership = (entry: DirtyEntry): DirtyEntry => (
        value_intent === 'in-overlay' && !dirty_entry_value_changed(entry)
            ? copy_dirty_entry(entry, { retainValue: true })
            : entry
    );

    if (hyperlinks_equal(next, persisted_link)) {
        // The requested link now matches the file. Drop the dimension, keeping
        // any value edit. Comparing with the ORIGINAL base would be wrong after
        // an external A -> C change: choosing A is then a real pending write
        // against current C, even though it equals the historical review base.
        if (value_intent !== 'in-overlay') {
            return { entry: undefined, overlay: absent_overlay() };
        }
        return planned(
            with_current_file_side(
                preserve_value_membership(copy_dirty_entry(
                    before_entry!,
                    { link: undefined, baseLink: undefined },
                )),
                base,
                persisted_link,
            ),
            'in-overlay',
        );
    }

    if (before_entry !== undefined) {
        return planned(
            with_current_file_side(
                preserve_value_membership(copy_dirty_entry(
                    before_entry,
                    { link: next, baseLink: base_link },
                )),
                base,
                persisted_link,
            ),
            value_intent,
        );
    }

    // Link-only entry: value dimension pinned at the base text.
    return planned(
        make_dirty_entry(
            base.text,
            base.text,
            base.rich,
            base.rich,
            next,
            base_link,
        ),
        'link-only',
    );
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
    const gestures_admitted = options?.gestures_admitted;
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

    // The cell's edit base in edit space: its effective rich content when
    // the loaded cell is available in markdown mode, else the plain raw text.
    // The fallback matters even in markdown mode — `get_cell_raw` layers the
    // in-flight save's values over residency, which `get_cell` cannot see, so
    // the raw reader stays the authority on the *text* and the loaded cell
    // only contributes styling.
    /**
     * One read of a cell's persisted side, answering both questions about it.
     *
     * `base` is what an edit is compared against and what an editor opens on; it
     * falls back to `''` for a cell whose page is not resident, because a wrong
     * base there only means the user retypes. `history` is the same content as
     * the side of an undo transition, and is `undefined` for exactly that cell:
     * as a history base the fallback would fabricate the missing side, and undo
     * would write an empty cell over content it never saw.
     *
     * Both come off one pair of loader reads. Asking twice per cell is a
     * thousand extra reads on a thousand-cell paste, and the rich-consistency
     * rule below — the loaded cell contributes styling only while its plain
     * projection still agrees with the raw reader, which sees an in-flight
     * save's values — is a policy that must not be spelled out in two places.
     */
    const read_persisted_cell = useCallback(
        (source_row: number, source_col: number): PersistedCellRead => {
            const raw = get_cell_raw(source_row, source_col);
            const text = raw ?? '';
            if (syntax !== 'markdown') {
                // CSV and TSV cannot carry an editable whole-cell hyperlink, so
                // `null` here is a known persisted state rather than a guess.
                return {
                    base: { text },
                    history: raw === undefined
                        ? undefined
                        : { value: history_value(text), hyperlink: null },
                };
            }
            const cell = get_cell?.(source_row, source_col);
            const base = cell != null && (cell.raw ?? '') === text
                ? cell_edit_base(cell)
                : { text };
            // `get_cell === undefined` is a consumer that supplies no rich
            // reader at all, not a page that has not arrived: the raw read is
            // then the whole persisted side, and residency is its answer alone.
            const resident = raw !== undefined && (get_cell === undefined || cell !== undefined);
            return {
                base,
                history: resident
                    ? {
                        value: history_value(base.text, base.rich),
                        hyperlink: cell?.hyperlink ?? null,
                    }
                    : undefined,
            };
        },
        [get_cell_raw, get_cell, syntax],
    );

    const edit_base_at = useCallback(
        (source_row: number, source_col: number): ParsedCellEdit =>
            read_persisted_cell(source_row, source_col).base,
        [read_persisted_cell],
    );
    const pending_base_at = useCallback((
        source_row: number,
        source_col: number,
    ): CsvObservedFileBase | undefined => {
        const persisted = read_persisted_cell(source_row, source_col);
        if (persisted.history === undefined) return undefined;
        return make_observed_file_base(
            persisted.history.value.text,
            persisted.history.value.runs,
        );
    }, [read_persisted_cell]);

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
                const value = dirty_value_edit_text(dirty_entry, syntax);
                set_editing_cell({
                    source_row,
                    source_col,
                    value: options?.formula_edit_text?.(
                        source_row,
                        source_col,
                        value,
                        dirty_entry.valueEditOrder ?? 0,
                    ) ?? value,
                });
                return;
            }
            const value = edit_display_text(edit_base_at(source_row, source_col), syntax);
            set_editing_cell({
                source_row,
                source_col,
                value: options?.formula_edit_text?.(
                    source_row, source_col, value,
                ) ?? value,
            });
        },
        [edit_base_at, dirty_cells, options?.formula_edit_text, syntax],
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

    const capture = options?.capture;

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
                before_overlay: CellOverlayState,
                persisted: PersistedCellRead,
            ) => PlannedOverlayWrite | undefined,
        ): boolean => {
            if (edits.length === 0) return false;
            if (gestures_admitted !== undefined && !gestures_admitted()) return false;
            const writes: StoreWrite[] = [];
            const changes: HistoryChange[] = [];
            // The store as this gesture found it, plus what the gesture has
            // written so far: a paste whose target overlaps a cell it already
            // wrote has to plan against its own earlier write, not against the
            // state the batch began in. Both the entry and the overlay it means,
            // because a planner needs the intent as much as the fields.
            const working = new Map<string, PlannedOverlayWrite>();

            for (const edit of edits) {
                const { source_row, source_col } = edit;
                if (!Number.isInteger(source_row) || source_row < 0) continue;
                if (!Number.isInteger(source_col) || source_col < 0) continue;
                const key = `${source_row}:${source_col}`;
                const persisted = read_persisted_cell(source_row, source_col);
                // Capture cannot represent a cell with no persisted side, so
                // while capturing that cell does not move either — an applied
                // edit history could not describe would let undo cross an
                // unrecorded change.
                //
                // Deliberately gated on capture rather than unconditional: a
                // non-resident cell is exactly the evicted-overlay case, where
                // committing under the key the editor opened with is the
                // behaviour the projection tests pin. Refusing it outright would
                // drop the user's own open edit.
                if (capture !== undefined && persisted.history === undefined) continue;
                const earlier = working.get(key);
                const before_entry = earlier !== undefined
                    ? earlier.entry
                    : active_store.get(key);
                // The exact overlay an earlier write in this gesture left, when
                // there was one; otherwise what the store holds, read with
                // `'infer'` because its writer's intent is long gone.
                const before_overlay = earlier?.overlay
                    ?? (before_entry === undefined
                        ? absent_overlay()
                        : overlay_state_from_dirty_entry(before_entry));

                const planned = plan(edit, before_entry, before_overlay, persisted);
                if (planned === undefined) continue;

                writes.push({ key, entry: planned.entry });
                working.set(key, planned);

                if (capture === undefined || persisted.history === undefined) continue;
                const change = build_cell_history_change({
                    worksheet: capture.worksheet,
                    sourceRow: source_row,
                    sourceColumn: source_col,
                    before: before_overlay,
                    after: planned.overlay,
                    persisted: persisted.history,
                });
                if (change !== undefined) changes.push(change);
            }

            // Every target was invalid or unavailable to the history capture.
            // Report refusal so a caller holding a draft keeps it open instead
            // of treating a no-op as a safely committed gesture.
            if (writes.length === 0) return false;

            const staged_writes = active_store.stage_writes(session_id, writes);
            // The session moved on: this hook's writes belong to a session that
            // is no longer current, so nothing lands and nothing is recorded.
            if (staged_writes === undefined) return false;
            // A plain action, deliberately not owned: recording owns as it walks
            // and abandons the walk the moment the hard bound is passed, so an
            // oversized paste it will refuse anyway must reach it unowned.
            const staged_record = capture?.history.stage_record({ label, changes });

            // Validate both before moving either: committing the edits and then
            // finding the history unrecordable would leave the two out of step.
            if (!staged_writes.valid()) return false;
            if (staged_record !== undefined && !staged_record.valid()) return false;

            staged_writes.commit();
            // A refusal commits too — its state is the barrier, and by decision
            // an oversized gesture stays applied with the history cleared behind
            // it rather than being rejected.
            staged_record?.commit();
            staged_writes.notify();
            staged_record?.notify();
            return true;
        },
        [active_store, capture, gestures_admitted, read_persisted_cell, session_id],
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
            let gesture_order: number | undefined;
            const next_edit_order = options?.next_value_edit_order;
            const ordered_edits = next_edit_order === undefined
                ? edits
                : edits.map((edit): CellValueEdit => {
                    if (edit.editOrder !== undefined) return edit;
                    const parsed = parse_cell_edit(edit.value, syntax);
                    if (!xlsx_edit_writes_formula(parsed.text, parsed.rich?.runs)) return edit;
                    gesture_order ??= next_edit_order();
                    return { ...edit, editOrder: gesture_order };
                });
            run_edit_gesture(ordered_edits, label, (edit, before_entry, _before_overlay, persisted) =>
                plan_value_write(
                    before_entry,
                    edit.value,
                    persisted.base,
                    persisted.history !== undefined
                        ? persisted.history.hyperlink
                        : get_cell?.(edit.source_row, edit.source_col)?.hyperlink ?? null,
                    persisted.history !== undefined,
                    syntax,
                    edit,
                ));
        },
        [get_cell, options?.next_value_edit_order, run_edit_gesture, syntax],
    );

    /**
     * Commit whole-cell hyperlink changes (dialog output): a link to set, or
     * null to clear. Reverting to a cell's current link removes the link
     * dimension — and the whole entry when no value change remains.
     */
    const commit_hyperlinks = useCallback(
        (edits: readonly CellHyperlinkEdit[], label = 'Edit hyperlink'): boolean =>
            run_edit_gesture(edits, label, (edit, before_entry, before_overlay, persisted) =>
                plan_hyperlink_write(
                    before_entry,
                    before_overlay,
                    edit.value,
                    persisted.base,
                    // `??` would be wrong here: a resident cell with no link
                    // reads `null`, which is an answer, not a missing one.
                    persisted.history !== undefined
                        ? persisted.history.hyperlink
                        : get_cell?.(edit.source_row, edit.source_col)?.hyperlink ?? null,
                )),
        [run_edit_gesture, get_cell],
    );

    const commit_hyperlink = useCallback(
        (source_row: number, source_col: number, next: CellHyperlink | null) =>
            commit_hyperlinks([{ source_row, source_col, value: next }]),
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
            if (active_entry?.observedBase !== undefined) {
                set_editing_cell(null);
            }
        }
        active_store.retain(
            session_id,
            (_key, entry) => entry.observedBase === undefined,
        );
    }, [active_store, editing_cell, dirty_cells, session_id]);

    // Resolve deferred bases for old-format restores: once a pending entry's page
    // becomes resident, capture its true on-disk value as the base. Runs whenever
    // the persisted-cell reader changes (the consumer rebinds it as pages load) and
    // whenever the map itself changes.
    //
    // `dirty_cells` is a real dependency, not defensive padding. An old-format
    // string map can now be installed into a *mounted* hook (a same-generation
    // refresh while editing), where get_cell_raw does not rebind because no page
    // loaded. Without this dep the pending entries would never be resolved for
    // already-resident rows: observation skips base_pending, so file-change
    // tracking would be silently off, and collect_save_payload
    // would keep refusing the save with no user-reachable way to clear it.
    useEffect(() => {
        // Hot-path guard: nothing pending means nothing to resolve, so skip the
        // Map rebuild + rescan entirely. get_cell_raw rebinds on every page load
        // and every commit produces a new map, so without this the effect would
        // re-run on every scroll and every keystroke.
        if (!active_store.has_pending_base()) return;
        active_store.resolve_pending_bases(session_id, pending_base_at);
    }, [active_store, pending_base_at, session_id, dirty_cells]);

    // Observe resident file changes and keep the original edit base intact.
    // The store owns the latest observed side so the notice survives grid
    // remounts and persistence; this effect only supplies loader-backed reads.
    useEffect(() => {
        const observations = new Map<string, CsvObservedFileBase>();
        for (const [key, entry] of dirty_cells) {
            if (entry.base_pending) continue;
            const [source_row, source_col] = key.split(':').map(Number);
            const persisted = read_persisted_cell(source_row, source_col);
            if (persisted.history === undefined) continue;
            const expected = dirty_entry_observed_base(entry);
            const text_changed = persisted.base.text !== expected.value;
            // The original formatting may be unknowable for an old sparse
            // draft, but once observedBase exists its runs are an exact CAS
            // baseline. Suppress only the first comparison to the unknown
            // historical side, never later observed-side changes.
            const formatting_changed = (
                entry.observedBase !== undefined
                || !dirty_entry_base_formatting_unknown(entry)
            )
                && !cell_edits_equal(
                    persisted.base,
                    { text: expected.value, rich: expected.runs },
                );
            const text_or_format_changed = text_changed || formatting_changed;
            const current_link = entry.link !== undefined
                ? persisted.history.hyperlink
                : undefined;
            const link_changed = entry.link !== undefined
                && !hyperlinks_equal(expected.link ?? null, current_link ?? null);
            if (!text_or_format_changed && !link_changed) continue;
            observations.set(key, make_observed_file_base(
                persisted.base.text,
                persisted.base.rich,
                current_link,
            ));
        }
        active_store.observe_file_bases(session_id, observations);
    }, [active_store, dirty_cells, read_persisted_cell, session_id]);

    const conflicted_keys = useMemo(() => {
        const keys = new Set<string>();
        for (const [key, entry] of dirty_cells) {
            if (entry.observedBase !== undefined) keys.add(key);
        }
        return keys;
    }, [dirty_cells]);

    // Close any open editor when the data reloads (token bump) — whether from our
    // own save or an external change. Dirty edits are preserved either way so the
    // user never silently loses unsaved work; observation then records any entry
    // whose file-side cell changed.
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
