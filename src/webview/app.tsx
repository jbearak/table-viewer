import React, {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    useLayoutEffect,
} from 'react';
import {
    EMPTY_TRANSFORM,
    MAX_PERSISTED_ROW_HEIGHTS,
    is_range_filter_operator,
    pending_edits_for_sheet,
    sheet_index_with_pending_edits,
    transform_has_entries,
    transform_is_active,
    transform_schema_for_sheet,
    with_pending_edits_for_sheet,
    worksheet_target_index,
    worksheet_target_lookup,
    type CellHighlightColor,
    type CellHighlightMutation,
    type CellHighlightSelection,
    type CellHighlightState,
    type CsvDirtyMap,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type CsvSaveWorksheetOperation,
    type DisplayRowInterval,
    type PerFileState,
    type SheetPendingEditCells,
    type HostMessage,
    type SheetTransformState,
    type FilterEntry,
    type SheetColumnVisibilityState,
    type SheetViewRecord,
    type TransformIntent,
    type ViewBasis,
} from '../types';
import type { WorkbookMeta } from '../data-source/interface';
import {
    classify_snapshot,
    normalize_complete_per_file_state,
    normalize_workbook_snapshot_state,
    type RetainedSnapshotCommandResult,
    type WorkbookSnapshotIdentity,
} from '../viewer-snapshot';
import { Toolbar, type ToolbarFocusHandle } from './toolbar';
import { FilterPopover } from './filter-popover';
import {
    order_relevant_dirty_keys,
    stale_view_signature,
    transform_progress_label,
    upsert_filter,
    type FilterHistogramReady,
    type FilterHistogramStatus,
} from './transform-ui-model';
import { SheetTabs, tab_orientation_label } from './sheet-tabs';
import { StateStrip } from './state-strip';
import { ContextMenu, type MenuItem } from './context-menu';
import {
    pending_sheet_action_to_run,
    type PendingSheetAction,
    type SheetAction,
} from './sheet-action-model';
import {
    GridShell,
    type EditingStatus,
    type EditingHandle,
    type GridActionsHandle,
    type GridFocusHandle,
    type HighlightSelectionHandle,
    type PendingPreviewScroll,
} from './grid-shell';
import {
    clamp_sheet_index,
    trim_sheet_state_array,
    sanitize_transform_state,
} from './sheet-state';
import {
    INITIAL_CSV_SAVE_PROJECTION,
    csv_save_operations_equal,
    propose_csv_save,
    reduce_csv_save_projection,
    resolve_csv_save_hydration,
    type CsvSaveProjection,
} from './csv-save-lifecycle';
import {
    create_edit_session_registry,
    type EditSessionRegistry,
} from './edit-session-registry';
import { column_letter } from './grid-model';
import {
    clamp_row_height,
    mapped_row_height_overlays,
    retained_row_height_overlay,
    row_height_layers_for_delivery,
    row_height_layers_with,
    type RowHeightLayer,
    type RowHeightOverlay,
} from './row-heights';
import {
    create_column_projection,
    hide_all_columns,
    hide_source_columns,
    sanitize_column_visibility_state,
    show_all_columns,
    toggle_source_column,
} from './column-projection';
import { use_state_sync } from './use-state-sync';
import {
    host_bridge,
    install_pending_edit_flush_responder,
    pending_edit_durability,
} from './host-bridge';
import { apply_font_family, apply_font_size } from './vscode-theme';
import {
    edit_command_target,
    text_field_selection,
    type EditCommand,
} from './edit-command';
import './styles.css';

type ColumnVisibilityUpdater = (
    current: SheetColumnVisibilityState | undefined,
    column_count: number,
    schema: string,
) => SheetColumnVisibilityState | undefined;

type TransformOrigin = 'grid' | 'toolbar' | 'restore';
type FilterHistogramState = FilterHistogramStatus;

const GRID_FOCUS_RESTORE_MAX_ATTEMPTS = 8;
const GRID_FOCUS_RESTORE_RETRY_MS = 16;

/**
 * No sheet has a resize in flight — the initial value, and the one a new document resets
 * to. A shared frozen constant so that "nothing pending" is always the *same* array, and
 * frozen so that neither use can be written through.
 *
 * Its *identity* is not load-bearing, and saying so is the point of this note: both uses
 * are one-shot. `useState` reads its initial value once, and the other is the
 * new-document reset, which re-renders the grid wholesale anyway — so substituting a fresh
 * `[]` at either site changes nothing observable, and probing confirms it (no test fails).
 * The identity that *does* matter is `mapped_row_height_overlays` handing back the very
 * array it was given when no sheet's verdict changed: that runs on every delivery and
 * every install ack, and it is pinned by its own unit test.
 */
const NO_ROW_HEIGHT_OVERLAYS: readonly (RowHeightOverlay | undefined)[] = Object.freeze([]);

function column_visibility_equal(
    left: SheetColumnVisibilityState | undefined,
    right: SheetColumnVisibilityState | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.schema !== right.schema) return false;
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 1-based, de-duplicated, ascending row numbers from source-keyed edit keys, for
 * the `rowsRemoved` banner. 1-based to match what the grid's row markers and the
 * context menu ("Row N") show; de-duplicated because several edits on one removed
 * row are one row to report, not several — the sentence counts rows, not keys.
 */
function rejected_rows(keys: readonly string[]): number[] {
    const rows = new Set<number>();
    for (const key of keys) {
        // Skip a key that names no row. `validate_dirty_bases` routes a malformed
        // key to `rowsRemoved`, so one can reach here, and `Number('a') + 1` would
        // put a literal "NaN" in the banner's row list.
        const row = Number(key.split(':')[0]);
        if (!Number.isInteger(row) || row < 0) continue;
        rows.add(row + 1);
    }
    return [...rows].sort((a, b) => a - b);
}

function sheet_widths_equal(
    left: Record<number, number> | undefined,
    right: Record<number, number> | undefined,
): boolean {
    if (left === right) return true;
    const left_keys = Object.keys(left ?? {});
    const right_keys = Object.keys(right ?? {});
    if (left_keys.length !== right_keys.length) return false;
    return left_keys.every((key) => (
        left![key as unknown as number] === right?.[key as unknown as number]
    ));
}

/**
 * Whether two row bases describe the same rows. The whole point of keeping the
 * basis inside `SheetViewRecord` is that this is the *only* question a snapshot has
 * to ask about an installed view: same rows, keep the record; different rows,
 * replace it. There is no way to answer it for the rules and not for the row count.
 */
function view_bases_equal(left: ViewBasis, right: ViewBasis): boolean {
    return left.generation === right.generation
        && left.sourceGeneration === right.sourceGeneration
        && left.schema === right.schema;
}

/**
 * A held record carrying the delivery's fresh hidden edited cells.
 *
 * Exactly one field of `SheetViewRecord` is edit-derived; `rules`, `rowCount` and
 * `basis` are all row-derived, and a same-basis refresh is by definition news about
 * neither the rows nor the rules. Taking only this one field is therefore not partial
 * invalidation of the record — it is the only field a delivery that moved no row can
 * have a newer answer for. What licenses taking it is the same basis equality that
 * licenses keeping the rest: the host samples these keys and the generation together,
 * so a generation still equal to the record's is proof these keys were computed
 * against the very permutation that record describes.
 *
 * A non-permuted record has no such field, and passes through: with no permutation
 * there is no row the view fails to show, and the host's answer for such a sheet is
 * empty for exactly that reason, so there is nothing here to take. Structural rather
 * than checked — the arm has no `hiddenEditedCellKeys` to write.
 *
 * Deliberately unconditional on the permuted arm rather than returning `held`
 * unchanged when the keys match. Probed rather than assumed: preserving the object's
 * identity fails no test, and it cannot — `set_sheet_views` rebuilds the array on
 * every applied snapshot regardless, and every consumer reads the record by value, the
 * restore effect included. A guard nothing can hold to account is worse than the
 * allocation it saves.
 */
function view_record_with_hidden_keys(
    held: SheetViewRecord,
    fresh: readonly string[],
): SheetViewRecord {
    if (!held.permuted) return held;
    return { ...held, hiddenEditedCellKeys: fresh };
}

/**
 * The view a Cancel rolls a pending transform request back to.
 *
 * Cancel is not an "apply now" affordance — it puts back the view that was already on
 * screen. When the held record is `permuted` that view is the host's permutation, and
 * the record's rules are its only description; they are basis-derived, so the record
 * is the right place to read them, and a sibling cannot move the durable rules out
 * from under an installed permutation without the restore reconciliation seeing it.
 *
 * When nothing is permuted there is no installed view to describe, so the baseline is
 * the durable intent — read live, at click time. A record's rules could not serve, and
 * the non-permuted arm no longer has any: a sibling that replaces or removes a
 * *disabled* filter definition moves no row, so nothing installs, no generation moves,
 * and the same-basis retention would go on holding definitions the sibling deleted.
 * Cancel persists what it sends, so reading that copy would silently resurrect them
 * over the sibling's update. `state_ref.current.transforms` is the same value that copy
 * came from, sanitized against the delivered schema by the snapshot handler before it
 * was stored, and it is what `handle_transform_change` already compares a new request
 * against.
 *
 * Wholly-inactive durable rules pass through as they are rather than being flattened
 * to empty: a filter the user merely switched off is a definition the host holds and
 * the toolbar shows, and sending empty would durably delete it. Rules with an active
 * part are a different case — they describe a view that is *not* on screen, a saved
 * transform still being restored — so cancelling that restore means going without it,
 * which is the empty state.
 */
function transform_rollback_baseline(
    installed: SheetViewRecord | undefined,
    durable: SheetTransformState | undefined,
    schema: string | undefined,
): SheetTransformState {
    if (installed?.permuted) return installed.rules;
    if (durable && transform_has_entries(durable) && !transform_is_active(durable)) {
        return durable;
    }
    return { sort: [], filters: [], schema };
}

export function transforms_semantically_equal(
    left: SheetTransformState | undefined,
    right: SheetTransformState | undefined,
): boolean {
    if (!transform_has_entries(left) && !transform_has_entries(right)) return true;
    if (!left || !right) return false;
    if (JSON.stringify(left.sort) !== JSON.stringify(right.sort)) return false;
    const left_hidden = [...(left.hiddenRows ?? [])].sort((a, b) => a - b);
    const right_hidden = [...(right.hiddenRows ?? [])].sort((a, b) => a - b);
    if (JSON.stringify(left_hidden) !== JSON.stringify(right_hidden)) return false;
    const semantic_filters = (filters: readonly FilterEntry[]) => filters
        .map((entry) => {
            const base = {
                colIndex: entry.colIndex,
                operator: entry.operator,
                enabled: entry.enabled,
            };
            if (entry.operator === 'isEmpty' || entry.operator === 'isNotEmpty') {
                return base;
            }
            if (entry.operator === 'isOneOf') {
                return {
                    ...base,
                    // Total order with null first and code-unit string compare, so
                    // equal exclusion sets always serialize identically (locale
                    // collation can tie distinct strings, e.g. '' vs null or
                    // composed vs decomposed Unicode).
                    excludedValues: [...(entry.excludedValues ?? [])].sort(
                        (a, b) => {
                            if (a === b) return 0;
                            if (a === null) return -1;
                            if (b === null) return 1;
                            return a < b ? -1 : 1;
                        },
                    ),
                };
            }
            return {
                ...base,
                value: entry.value ?? '',
                secondValue: is_range_filter_operator(entry.operator)
                    ? entry.secondValue ?? ''
                    : undefined,
                caseSensitive: entry.caseSensitive,
            };
        })
        .sort((a, b) => a.colIndex - b.colIndex);
    return JSON.stringify(semantic_filters(left.filters))
        === JSON.stringify(semantic_filters(right.filters));
}

function transform_reconciliation_required(
    durable: SheetTransformState | undefined,
    installed: SheetViewRecord | undefined,
): boolean {
    if (transforms_semantically_equal(
        durable,
        installed?.permuted ? installed.rules : undefined,
    )) return false;
    return transform_is_active(durable) || installed?.permuted === true;
}

/** Shared so clearing an already-empty auto-fit queue is not a state change. */
const EMPTY_PENDING_AUTO_FIT: ReadonlySet<number> = new Set<number>();

/** Webview root for snapshot metadata plus paginated row delivery. */
export function App(): React.JSX.Element {
    const [meta, set_meta] = useState<WorkbookMeta | null>(null);
    const [generation, set_generation] = useState(0);
    // Bumped on every initial snapshot (a fresh document load — including the
    // preview pane reusing its panel for a different file). Folded into the GridShell key
    // so the row loader remounts clean; a new file can otherwise collide with the
    // previous one's generation (both start at 1) and surface stale cached pages.
    const [load_epoch, set_load_epoch] = useState(0);
    const [active_sheet_index, set_active_sheet_index] = useState(0);
    // Per sheet, not per workbook (#154). Formatting is a view setting like the rest
    // of the right-hand toolbar group, and reading one sheet raw while another stays
    // formatted is a real thing to want. Sparse: an absent entry means the default,
    // which is why every read goes through `?? true`.
    const [show_formatting_by_sheet, set_show_formatting_by_sheet] =
        useState<(boolean | undefined)[]>([]);
    const [vertical_tabs, set_vertical_tabs] = useState(false);
    const [column_widths, set_column_widths] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [column_visibility, set_column_visibility] = useState<
        (SheetColumnVisibilityState | undefined)[]
    >([]);
    // Per sheet, the host's *display*-keyed projection of the durable row heights —
    // never the durable map itself, which is keyed by canonical source row and which
    // this webview neither holds nor writes (see `PerFileState.rowHeights`). Only the
    // host can join the two, because only the host knows the permutation and holds every
    // source row; a resize can commit rows this webview has never loaded.
    //
    // It arrives on the two carriers that are each sampled beside the generation they
    // describe: `WorkbookSnapshot.rowHeightProjection` on every delivery, and
    // `transformInstalled.rowHeights` on an install, which posts no snapshot. It is
    // deliberately not on `SheetViewRecord`: a record is retained across a same-basis
    // refresh, and the durable heights move with no basis change at all (a sibling
    // panel's write, an excel-header plan edit), so a retained projection would go stale
    // invisibly. Held here instead, replaced whole by every delivery.
    const [row_height_projection, set_row_height_projection] = useState<
        (Readonly<Record<number, number>> | undefined)[]
    >([]);
    // Resizes this panel has committed and posted but not yet seen come back.
    //
    // Display-keyed, like the projection it renders over, so no display→source mapping
    // is needed to show one — which the webview could not do anyway for a select-all.
    // Held as intervals + one height per commit rather than expanded entries: a
    // select-all resize names every row of the sheet, and expanding that would cost one
    // map entry per row to record a single number (see `RowHeightLayer`).
    //
    // Indexed by sheet, and tagged with the view generation the display rows were read
    // off. Per sheet because two resizes can be in flight on two sheets at once — the user
    // drags a boundary, opens another tab and drags there before the first answer arrives —
    // and a single slot made the second discard the first, so returning to the first sheet
    // showed a completed resize snapping back until its delivery landed.
    //
    // What voids an entry is not a generation change as such but *that sheet's* mapping
    // moving after the generation it was tagged with — the host's own test, applied here to
    // the same numbers, so that the two sides cannot disagree about whether a queued resize
    // is still meaningful. When it is voided the numbers in it name positions in an
    // arrangement that no longer exists, and that is also the entire user-visible answer to
    // a resize the host refuses as stale: the row springs back, with no refusal message and
    // deliberately no replay, because replaying would resize whatever rows now sit at those
    // positions. Both the rule and the reasons for it are at `retained_row_height_overlay`.
    const [row_height_overlay, set_row_height_overlay] = useState<
        readonly (RowHeightOverlay | undefined)[]
    >(NO_ROW_HEIGHT_OVERLAYS);
    const [auto_fit_active, set_auto_fit_active] = useState<boolean[]>([]);
    const [auto_fit_snapshot, set_auto_fit_snapshot] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    /**
     * Sheets marked "auto-fit" that have not been measured yet.
     *
     * Fitting reads the mounted grid's *loaded* rows, so a sheet the user has never
     * opened has nothing to measure — there is no width to compute without first
     * mounting its grid and loading rows. Rather than flicker the whole workbook
     * through the viewport to service one menu click, "auto-fit all sheets" marks
     * them and each fits on arrival. That matches what auto-fit already promises on
     * the active sheet, where it only ever measures what is loaded.
     */
    const [pending_auto_fit_sheets, set_pending_auto_fit_sheets] =
        useState<ReadonlySet<number>>(EMPTY_PENDING_AUTO_FIT);
    const pending_auto_fit_sheets_ref = useRef<ReadonlySet<number>>(
        EMPTY_PENDING_AUTO_FIT,
    );
    const update_pending_auto_fit_sheets = useCallback((
        update: ReadonlySet<number> | (
            (previous: ReadonlySet<number>) => ReadonlySet<number>
        ),
    ) => {
        const previous = pending_auto_fit_sheets_ref.current;
        const next = typeof update === 'function' ? update(previous) : update;
        if (next === previous) return;
        pending_auto_fit_sheets_ref.current = next;
        set_pending_auto_fit_sheets(next);
    }, []);
    const cancel_pending_auto_fit_for_sheet = useCallback((sheet_index: number) => {
        update_pending_auto_fit_sheets((prev) => {
            if (!prev.has(sheet_index)) return prev;
            const next = new Set(prev);
            next.delete(sheet_index);
            return next;
        });
    }, [update_pending_auto_fit_sheets]);
    const [truncation_message, set_truncation_message] = useState<string | null>(null);
    const [preview_mode, set_preview_mode] = useState(false);
    const [csv_editable, set_csv_editable] = useState(false);
    const [csv_editing_supported, set_csv_editing_supported] = useState(false);
    const [csv_edit_session_id, set_csv_edit_session_id_state] = useState<string>();
    const csv_edit_session_id_ref = useRef<string>();
    /**
     * The edit *pointer*: the worksheet the workbook-scoped session is
     * currently editing on screen. The dirty maps live per sheet in the
     * registry; this names the one the mounted grid, the save operation and
     * the default hydration reads work in. Set from the grant the host echoes
     * back rather than from the active tab, so a sheet switch mid-session
     * cannot silently retarget an in-flight save.
     */
    const edit_session_sheet_index_ref = useRef<number>(0);
    const renderer_publication_fenced_session_ref = useRef<string>();
    // The dirty maps, one per worksheet, owned here so they survive the
    // generation-keyed GridShell remounts that a transform or refresh snapshot
    // forces.
    //
    // A registry rather than a single store because the session covers the
    // whole workbook (#154): each sheet keeps its own map in its own `row:col`
    // key space, which is what lets the store and the `use_editing` hook stay
    // sheet-agnostic.
    // Reads the session id ref rather than holding a copy: the ref is the one
    // authoritative value, it moves synchronously in set_csv_edit_session_id,
    // and a store built after that move is stamped from it at creation — so
    // new stores are fenced against the outgoing session's writers with
    // nothing to keep in lockstep.
    const edit_session_registry_ref = useRef<EditSessionRegistry | null>(null);
    if (edit_session_registry_ref.current === null) {
        edit_session_registry_ref.current = create_edit_session_registry(
            () => csv_edit_session_id_ref.current,
        );
    }
    const set_csv_edit_session_id = useCallback((next: string | undefined) => {
        const previous = csv_edit_session_id_ref.current;
        if (next && next !== previous) {
            renderer_publication_fenced_session_ref.current = undefined;
        }
        if (previous && previous !== next) {
            pending_edit_durability.retire(previous);
            edit_session_registry_ref.current?.retire_parked();
        }
        csv_edit_session_id_ref.current = next;
        set_csv_edit_session_id_state(next);
    }, []);
    const [edit_mode, set_edit_mode_state] = useState(false);
    const edit_mode_ref = useRef(false);
    const set_edit_mode = useCallback((next: boolean) => {
        edit_mode_ref.current = next;
        set_edit_mode_state(next);
    }, []);
    // One granted session makes every worksheet editable. The active tab chooses
    // only which per-sheet store the mounted grid views; it is not an edit pointer.
    const edit_mode_on_active_sheet = edit_mode;
    const [edit_session_pending, set_edit_session_pending] = useState(false);
    const [save_operation, set_save_operation] = useState<CsvSaveOperation>();
    const [save_lifecycle, set_save_lifecycle] = useState<CsvSaveLifecycle>(
        INITIAL_CSV_SAVE_PROJECTION.authoritative,
    );
    const [transforms, set_transforms] = useState<
        (SheetTransformState | undefined)[]
    >([]);
    // Per sheet, the view the host has installed: its rules, its post-filter row
    // count, whether the order is permuted — and the row basis all three were
    // computed against, which is what makes this one value rather than three.
    //
    // Three separately-stored atoms held this before (`applied_transforms`,
    // `effective_row_counts`, and a boolean recording that some install had landed),
    // and three review findings on this PR were the same mistake: a snapshot
    // invalidating some of them and not the others, so `transform_active` disagreed
    // with the row count the loader was using, or a reset path was forgotten.
    // Carrying the basis inside the record makes partial invalidation unwritable —
    // an incoming snapshot either matches the basis, and the record stands whole, or
    // it does not, and the record is replaced whole by the natural view that
    // snapshot describes.
    const [sheet_views, set_sheet_views] = useState<
        (SheetViewRecord | undefined)[]
    >([]);
    const [pending_transforms, set_pending_transforms] = useState<boolean[]>([]);
    const [pending_transform_labels, set_pending_transform_labels] = useState<string[]>([]);
    const [pending_excel_header, set_pending_excel_header] = useState<string | null>(null);
    const [excel_header_status, set_excel_header_status] = useState('');
    const [filter_editor, set_filter_editor] = useState<{
        column_index: number;
        anchor: { left: number; top: number };
        restore_focus: () => void;
        origin: Exclude<TransformOrigin, 'restore'>;
    } | null>(null);
    const [sheet_context_menu, set_sheet_context_menu] = useState<{
        // Null for a right-click on the tab strip's own background rather than on a
        // tab: the tab-orientation command applies to the strip, so it is offered
        // there too, while the per-sheet actions have no sheet to act on.
        sheet_index: number | null;
        x: number;
        y: number;
    } | null>(null);
    const [pending_sheet_action, set_pending_sheet_action] =
        useState<PendingSheetAction | null>(null);
    const [filter_histogram, set_filter_histogram] = useState<{
        key: string;
        value: FilterHistogramState;
    }>({ key: '', value: { status: 'loading' } });
    const [pending_preview_scroll, set_pending_preview_scroll] =
        useState<PendingPreviewScroll | null>(null);
    const [grid_focus_restore, set_grid_focus_restore] = useState<{
        sheet_index: number;
        generation: number;
        document_epoch: number;
    } | null>(null);
    const [toolbar_focus_restore, set_toolbar_focus_restore] = useState<{
        sheet_index: number;
        document_epoch: number;
    } | null>(null);
    const [source_epoch, set_source_epoch] = useState(0);
    const [editing_status, set_editing_status] = useState<EditingStatus | null>(null);
    const [cell_highlights, set_cell_highlights] = useState<CellHighlightState>();
    const [active_highlight_color, set_active_highlight_color] =
        useState<CellHighlightColor>('yellow');
    const [highlight_selection_available, set_highlight_selection_available] =
        useState(false);
    const [highlight_request_pending, set_highlight_request_pending] = useState(false);
    const [highlight_status, set_highlight_status] = useState('');
    // Conflict signature the user dismissed ("Keep All"); the banner reappears only
    // if a *different* set of cells later conflicts.
    const [dismissed_conflict_signature, set_dismissed_conflict_signature] =
        useState<string | null>(null);
    // Stale-view signature the user acknowledged ("Dismiss"). Purely informational:
    // the banner it silences states that the displayed order does not recompute
    // mid-edit, which is intended, so acknowledging it must not touch the view. It
    // reappears once a *different* set of order-relevant edits — or a different
    // installed sort or filter — makes that statement a new fact.
    const [acknowledged_stale_signature, set_acknowledged_stale_signature] =
        useState<string | undefined>(undefined);
    // Keys the *host* refused a save over, from a saveResult's `rejection`. These
    // exist because the webview cannot derive them: is_entry_conflicted is
    // residency-gated, so an edit on a filtered-out row, an evicted page, or a row
    // past the current row count is never in `conflicted_keys`. Without this state a
    // rejected save would be permanently unrecoverable — the banner would not
    // render, the cell would not exist to right-click, and Discard Conflicted (a
    // retain over is_entry_conflicted) would keep the very entry blocking the save.
    //
    // Stamped with the session it belongs to and with the *exact entries* it was a
    // verdict over. Both are load-bearing. The session stamp is what stops a
    // rejection from a previous session riding into a new one on a restored
    // `pendingEdits` map (the adoption guard at the set site gates only adoption;
    // after that the state carried no session at all). The entries are what stop a
    // rejection outliving the edit it named: a key can leave the map and come back
    // with a *fresh* value and a base re-read from the current file, and a
    // membership-only test would re-raise "save was cancelled" over an edit the host
    // has never seen.
    const [save_rejection, set_save_rejection] = useState<{
        reason: 'baseMismatch' | 'rowsRemoved';
        keys: string[];
        session_id: string | undefined;
        sheet_index: number;
        sheet_name: string | undefined;
        worksheet_id: string | undefined;
        entries: Record<string, { value: string; base: string }>;
    } | null>(null);

    const state_ref = useRef<PerFileState>({});
    // GridShell populates this with imperative save/discard actions (the dirty map
    // lives next to the loader); App calls them from the toolbar + conflict banner.
    const editing_ref = useRef<EditingHandle | null>(null);
    // GridShell populates this with a measure function returning fitted column
    // widths (null when nothing is loaded); App calls it from the auto-fit toggle.
    const auto_fit_ref = useRef<(() => Record<number, number> | null) | null>(null);
    // GridShell populates this with sheet-tab actions (select all / copy sheet)
    // for the mounted sheet; App calls them from the sheet-tab context menu.
    const grid_actions_ref = useRef<GridActionsHandle | null>(null);
    // True between posting a save (from the exit dialog) and its saveResult, so a
    // successful save then completes the deferred exit from edit mode.
    const pending_exit_ref = useRef(false);
    const auto_fit_active_ref = useRef<boolean[]>([]);
    const auto_fit_snapshot_ref = useRef<
        (Record<number, number> | undefined)[]
    >([]);
    const transform_request_seq_ref = useRef(0);
    const transform_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    const histogram_request_seq_ref = useRef(0);
    const histogram_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    const edit_request_seq_ref = useRef(0);
    const edit_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    const save_request_seq_ref = useRef(0);
    const save_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    const dialog_request_seq_ref = useRef(0);
    const excel_header_request_seq_ref = useRef(0);
    const excel_header_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    const pending_excel_header_ref = useRef<string | null>(null);
    // Mirrors editing_status.save_in_flight for the transform request paths. A ref
    // rather than the state value in their dep arrays: the grid reports editing
    // status on every commit, so depending on it would rebuild these callbacks —
    // and with them GridShell's props — on each keystroke. Written synchronously
    // in handle_editing_change, so a request always reads the latest report and
    // there is no closure to go stale.
    const save_in_flight_ref = useRef(false);
    const pending_excel_header_unhide_ref = useRef(false);
    const pending_excel_header_promote_ref = useRef(false);
    const pending_edit_request_ref = useRef<string | null>(null);
    const pending_save_dialog_ref = useRef<{
        requestId: string;
        editSessionId: string;
    } | null>(null);
    const save_projection_ref = useRef<CsvSaveProjection>(
        INITIAL_CSV_SAVE_PROJECTION,
    );
    const meta_ref = useRef<WorkbookMeta | null>(null);
    const pending_transform_request_ids_ref = useRef<(string | undefined)[]>([]);
    const pending_transform_states_ref = useRef<(SheetTransformState | undefined)[]>([]);
    const pending_transform_origins_ref = useRef<(TransformOrigin | undefined)[]>([]);
    // Request-dedup bookkeeping, both of these, and deliberately *not* part of
    // `sheet_views`: they record what has already been asked of the host, which is a
    // different fact from what the host installed, and folding them into the view
    // record would make a refusal — which changes no view — look like one.
    //
    // Per sheet, the `restore_blocker_epoch` in force when the restore effect last
    // asked the host to reconcile to the persisted transform — installing it, or
    // uninstalling one the durable rules no longer describe — cleared once either
    // lands. Only of what has already been asked and refused, so the ask is not
    // repeated verbatim; `sheet_views` remains the only answer to what is installed.
    const restore_request_blockers_ref = useRef<(number | undefined)[]>([]);
    // Per sheet, whether the restore was refused for a reason that will never clear
    // (out-of-range sheet, stale source generation, schema mismatch, a failed
    // compute). The blocker stamp above suppresses only a *verbatim* repeat under
    // unchanged conditions, so without this a saved transform this sheet can no
    // longer support would be asked for — with its global warning — every time a
    // blocker moved. Cleared by every applied snapshot, which is the point at which
    // the sheet may well be able to support it again.
    const restore_abandoned_ref = useRef<boolean[]>([]);
    const generation_ref = useRef(1);
    const source_generation_ref = useRef(1);
    const mapping_generations_ref = useRef<number[]>([]);
    const histogram_cache_ref = useRef(new Map<string, FilterHistogramReady>());
    const pending_histogram_ref = useRef<{
        requestId: string;
        key: string;
        sheetIndex: number;
        columnIndex: number;
        generation: number;
        sourceGeneration: number;
    } | null>(null);
    const snapshot_identity_ref = useRef<WorkbookSnapshotIdentity | null>(null);
    const last_applied_snapshot_ref = useRef<WorkbookSnapshotIdentity | null>(null);
    const processed_snapshot_results_ref = useRef(new Set<string>());
    const document_epoch_ref = useRef(0);
    const preview_mode_ref = useRef(false);
    const preview_scroll_sequence_ref = useRef(0);
    const pending_preview_scroll_ref = useRef<PendingPreviewScroll | null>(null);
    const last_preview_visible_row_ref = useRef<number | null>(null);
    const filter_restore_timer_ref = useRef<number | undefined>(undefined);
    const grid_focus_ref = useRef<GridFocusHandle | null>(null);
    const toolbar_focus_ref = useRef<ToolbarFocusHandle | null>(null);
    const highlight_ref = useRef<HighlightSelectionHandle | null>(null);
    const highlight_request_seq_ref = useRef(0);
    const highlight_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    const pending_highlight_request_ref = useRef<string | null>(null);
    const last_highlight_state_revision_ref = useRef(0);

    const { persist_immediate } = use_state_sync(
        state_ref,
        source_generation_ref,
        snapshot_identity_ref,
    );

    useLayoutEffect(() => install_pending_edit_flush_responder(async () => {
        const edit_session_id = csv_edit_session_id_ref.current;
        if (!edit_session_id) return { highestProducedSequence: 0 };

        // This is the document-lifetime close/reload boundary. Fence the mounted
        // grid synchronously, then fold its live overlay before sampling the
        // App-owned store that survives generation-keyed GridShell remounts.
        const editing = editing_ref.current;
        editing?.stop_edit_admission();
        editing?.commit_live_edit();
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        const durability = pending_edit_durability.snapshot(edit_session_id);
        const publication_fenced = renderer_publication_fenced_session_ref.current
            === edit_session_id;
        let highest_produced_sequence = durability.highestProducedSequence;
        if (!save_in_flight_ref.current && !publication_fenced) {
            // The session is workbook-scoped: any sheet's store may hold edits
            // the host has not durably acknowledged, not just the sheet the
            // edit pointer names. Publish each store's current truth — content
            // or explicit null — so the host's slots match what the user sees
            // when the document comes back.
            for (const { target, store, parked } of
                edit_session_registry_ref.current!.publication_entries(
                    meta_ref.current?.sheets ?? [],
                )) {
                const snapshot = store.snapshot();
                if (
                    !parked
                    && snapshot.size === 0
                    && !pending_edit_durability.has_publication(
                        edit_session_id,
                        target.sheetIndex,
                        target.sheetName,
                        target.worksheetId,
                    )
                ) continue;
                highest_produced_sequence = Math.max(
                    highest_produced_sequence,
                    pending_edit_durability.publish(
                        edit_session_id,
                        snapshot.size > 0 ? Object.fromEntries(snapshot) : null,
                        target.sheetIndex,
                        target.sheetName,
                        pending_edit_durability.has_unacknowledged_payload(
                            edit_session_id,
                            target.sheetIndex,
                            target.sheetName,
                            target.worksheetId,
                        ),
                        target.worksheetId,
                    ),
                );
            }
        }
        return {
            editSessionId: edit_session_id,
            highestProducedSequence: highest_produced_sequence,
        };
    }), []);

    const request_transform = useCallback((
        sheet_index: number,
        state: SheetTransformState,
        intent: TransformIntent,
        origin: TransformOrigin = 'toolbar',
    ) => {
        const request_id = [
            'transform',
            transform_request_prefix_ref.current,
            sheet_index,
            ++transform_request_seq_ref.current,
        ].join(':');
        pending_transform_request_ids_ref.current[sheet_index] = request_id;
        pending_transform_states_ref.current[sheet_index] = state;
        pending_transform_origins_ref.current[sheet_index] = origin;
        set_pending_transforms((prev) => {
            const next = [...prev];
            next[sheet_index] = true;
            return next;
        });
        set_pending_transform_labels((prev) => {
            const next = [...prev];
            next[sheet_index] = transform_progress_label(
                state_ref.current.transforms?.[sheet_index] ?? EMPTY_TRANSFORM,
                state,
                intent,
            );
            return next;
        });
        host_bridge.postMessage({
            type: 'setTransform',
            sheetIndex: sheet_index,
            state,
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
            intent,
        });
    }, []);

    /**
     * Drop the host's save verdict and any banner dismissal together.
     *
     * They must move as a pair, because the banner now honours the dismissal for a
     * host rejection too (see `show_conflict_banner`). `conflict_signature` covers
     * only the webview-derived conflicts, so a "Keep All" pressed over a rejection
     * with no derived conflicts records the empty signature — and leaving that
     * behind would silently suppress the *next* rejection, which would also present
     * with no derived conflicts. Conversely, clearing the rejection while keeping
     * the dismissal is what lets a stale dismissal outlive the thing it dismissed.
     * Every caller is a point where the map or the session the verdict described is
     * replaced, which is exactly when both facts stop being true.
     */
    const clear_save_verdict = useCallback(() => {
        set_save_rejection(null);
        set_dismissed_conflict_signature(null);
    }, []);

    const fence_edit_session_exit = useCallback((edit_session_id: string) => {
        // Fence both the document-level final publication and every mounted-grid
        // publication before the terminal message can reach the host. Otherwise a
        // concurrent close flush can sample a sequence emitted after release began,
        // which the releasing host correctly refuses and therefore never acknowledges.
        renderer_publication_fenced_session_ref.current = edit_session_id;
        editing_ref.current?.stop_edit_admission();
        pending_save_dialog_ref.current = null;
    }, []);

    const release_edit_session = useCallback(() => {
        if (!csv_edit_session_id) return;
        fence_edit_session_exit(csv_edit_session_id);
        host_bridge.postMessage({
            type: 'releaseEditSession',
            editSessionId: csv_edit_session_id,
        });
    }, [csv_edit_session_id, fence_edit_session_exit]);

    const leave_edit_mode = useCallback(() => {
        set_edit_mode(false);
        release_edit_session();
        // A verdict is scoped to an editing session. Leaving edit mode ends the one
        // it belonged to, so nothing it named can still be pending.
        clear_save_verdict();
    }, [clear_save_verdict, release_edit_session]);

    const discard_edit_session = useCallback(() => {
        if (!csv_edit_session_id) return;
        fence_edit_session_exit(csv_edit_session_id);
        set_edit_mode(false);
        // Every edit is being thrown away, including the rejected ones.
        clear_save_verdict();
        // Every sheet's, not just the mounted grid's: the session covers the
        // whole workbook and the host clears every live durable slot, so a
        // store left full here would repaint edits the user just discarded
        // the next time its sheet is opened.
        edit_session_registry_ref.current!.clear_all(csv_edit_session_id);
        host_bridge.postMessage({
            type: 'discardEditSession',
            editSessionId: csv_edit_session_id,
        });
    }, [clear_save_verdict, csv_edit_session_id, fence_edit_session_exit]);

    const begin_save_operation = useCallback((): CsvSaveOperation | undefined => {
        if (!csv_edit_session_id || save_projection_ref.current.operation) return undefined;
        const sheets = meta_ref.current?.sheets ?? [];
        const preflight = edit_session_registry_ref.current!
            .collect_dirty_worksheets(sheets);
        if (preflight.status === 'blocked') {
            host_bridge.postMessage({
                type: 'showWarning',
                message: preflight.reason === 'unresolvedBases'
                    ? 'Load every edited row before saving so its conflict base can be verified.'
                    : 'A worksheet containing unsaved edits was removed. Restore it or discard the workbook edit session before saving.',
            });
            return undefined;
        }
        if (preflight.worksheets.length === 0) return undefined;
        const worksheets = preflight.worksheets.map(({ target, edits, dirtyEdits }) =>
            Object.freeze<CsvSaveWorksheetOperation>({
                ...target,
                edits,
                dirtyEdits,
            }));
        const operation = Object.freeze<CsvSaveOperation>({
            editSessionId: csv_edit_session_id,
            saveRequestId: [
                'save',
                save_request_prefix_ref.current,
                ++save_request_seq_ref.current,
            ].join(':'),
            worksheets: Object.freeze(worksheets),
        });
        const projection = propose_csv_save(save_projection_ref.current, operation);
        save_projection_ref.current = projection;
        set_save_operation(operation);
        save_in_flight_ref.current = true;
        host_bridge.postMessage({ type: 'saveCsv', operation });
        return operation;
    }, [csv_edit_session_id]);

    const reset_save_projection = useCallback(() => {
        save_projection_ref.current = INITIAL_CSV_SAVE_PROJECTION;
        set_save_lifecycle(INITIAL_CSV_SAVE_PROJECTION.authoritative);
        set_save_operation(undefined);
    }, []);

    // The single edit-map hydration boundary. The registry store outlives the
    // generation-keyed grid; installing here stamps the session so a write from a
    // previously mounted hook cannot land in another session's map.
    const install_edit_session = useCallback((
        edits: SheetPendingEditCells | undefined,
        session_id: string | undefined,
        // The worksheet whose key space `edits` is in. Defaults to the session
        // pointer; a save's hydration passes its operation's own sheet, so a
        // pointer that moved on to another worksheet mid-lifecycle cannot pull
        // the restored map into the wrong store.
        sheet_index: number = edit_session_sheet_index_ref.current,
    ) => {
        // Read the outgoing stamp before install overwrites it.
        const store = edit_session_registry_ref.current!.for_sheet(sheet_index);
        const previous_identity = store.identity();
        store.install({ session_id }, edits);
        // An acknowledgement is about a specific set of dirty cells, so it expires
        // when the *session* it belonged to does — not on every crossing of this
        // boundary. Crossing it is not by itself evidence of a new dirty map: the
        // host echo after pendingEditsChanged and failed-save hydration both
        // re-install the identical map for the same session, and resetting there
        // resurrected a banner the user had just dismissed as soon as a delayed
        // echo landed.
        //
        // Keying on the session id still covers every path that genuinely replaces
        // the map: a successful save plus reload, a discard and a re-grant either
        // change the session id or install an empty map — and an empty dirty map
        // makes the signature `undefined`, which hides the banner on its own with
        // no acknowledgement to expire. A never-stamped store counts as a change;
        // the reset is a no-op there.
        if (
            previous_identity === null
            || previous_identity.session_id !== session_id
        ) {
            set_acknowledged_stale_signature(undefined);
        }
        // Deliberately does NOT clear the host's save verdict. Crossing this
        // boundary is not evidence that the judged map is gone: the refresh branch
        // installs on a snapshot for our *own* session, and what it installs is
        // resolve_csv_save_hydration's restore of the failed operation's own
        // dirtyEdits — byte-identical to the map the host just judged. A capability
        // recapture is enough to land there (the rejection's own pendingEdits write
        // notifies edit state), so clearing here dropped the banner, the tint, and
        // both of its exits while the rejection was still true — and for a host-only
        // rejection the banner is the only recovery affordance there is.
        //
        // The verdict expires on its own facts instead: the session stamp and the
        // per-key value/base comparison in `live_rejected_keys` (a replaced or
        // departed entry stops matching), the clear at the top of the saveResult
        // handler for a superseding result, leave_edit_mode/discard_edit_session for
        // a session that ends, and the explicit clear in the 'initial' reset block
        // for a fresh document.
    }, []);

    const apply_save_lifecycle = useCallback((incoming: CsvSaveLifecycle) => {
        const previous = save_projection_ref.current;
        const next = reduce_csv_save_projection(previous, incoming);
        if (next === previous) return { previous, next, changed: false };
        save_projection_ref.current = next;
        set_save_lifecycle(next.authoritative);
        set_save_operation(next.operation);

        // The authoritative lifecycle is what the fence is really about; the
        // owning grid's report is only the usual way it is heard. While the user
        // is on another worksheet there is no owning grid mounted, and a *failed*
        // save keeps the session, so nothing was left to lower the fence: every
        // transform was silently refused and the close flush published nothing,
        // until the user happened to visit the owning sheet again.
        if (next.authoritative.state !== 'active') {
            save_in_flight_ref.current = false;
        }

        const current_session_id = csv_edit_session_id_ref.current;
        const hydrate_and_install = (operation: CsvSaveOperation) => {
            const sheet_index_for = worksheet_target_lookup(meta_ref.current?.sheets ?? []);
            for (const worksheet of operation.worksheets) {
                const sheet_index = sheet_index_for(worksheet);
                if (sheet_index === undefined) continue;
                const entries = edit_session_registry_ref.current!
                    .for_sheet(sheet_index).snapshot();
                const hydrated = resolve_csv_save_hydration(
                    next,
                    current_session_id,
                    sheet_index,
                    meta_ref.current?.sheets[sheet_index]?.name,
                    meta_ref.current?.sheets[sheet_index]?.worksheetId,
                    entries.size > 0 ? Object.fromEntries(entries) : undefined,
                );
                install_edit_session(hydrated, current_session_id, sheet_index);
            }
        };
        if (incoming.state === 'active') {
            if (
                incoming.operation.editSessionId === current_session_id
                && csv_save_operations_equal(next.operation, incoming.operation)
            ) {
                hydrate_and_install(incoming.operation);
            }
        } else if (
            incoming.state !== 'idle'
            && (!previous.operation
                || csv_save_operations_equal(previous.operation, incoming.operation))
        ) {
            if (incoming.state === 'failed') {
                if (
                    previous.operation
                    && incoming.operation.editSessionId === current_session_id
                    && csv_save_operations_equal(
                        previous.operation,
                        incoming.operation,
                    )
                ) {
                    hydrate_and_install(incoming.operation);
                    pending_exit_ref.current = false;
                }
            } else if (
                current_session_id === undefined
                || incoming.operation.editSessionId === current_session_id
            ) {
                hydrate_and_install(incoming.operation);
                set_csv_edit_session_id(undefined);
                set_edit_session_pending(false);
                set_edit_mode(false);
            }
        }
        return { previous, next, changed: true };
    }, [install_edit_session, set_csv_edit_session_id, set_edit_mode]);

    useEffect(() => {
        auto_fit_active_ref.current = auto_fit_active;
    }, [auto_fit_active]);

    useEffect(() => {
        auto_fit_snapshot_ref.current = auto_fit_snapshot;
    }, [auto_fit_snapshot]);

    const clear_pending_preview_scroll = useCallback(() => {
        pending_preview_scroll_ref.current = null;
        set_pending_preview_scroll(null);
    }, []);

    const queue_preview_scroll = useCallback((row: number) => {
        const pending = {
            row,
            sequence: ++preview_scroll_sequence_ref.current,
        };
        pending_preview_scroll_ref.current = pending;
        set_pending_preview_scroll(pending);
    }, []);

    useEffect(() => {
        preview_mode_ref.current = preview_mode;
        if (!preview_mode) {
            last_preview_visible_row_ref.current = null;
            clear_pending_preview_scroll();
        }
    }, [clear_pending_preview_scroll, preview_mode]);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;

            if (msg.type === 'cellHighlightsChanged') {
                const identity = snapshot_identity_ref.current;
                if (
                    !identity
                    || msg.physicalRevision !== identity.sourceBasis.physicalRevision
                    || msg.sourceGeneration !== source_generation_ref.current
                ) return;
                const matching_request = !!msg.requestId
                    && pending_highlight_request_ref.current === msg.requestId;
                if (matching_request) {
                    pending_highlight_request_ref.current = null;
                    set_highlight_request_pending(false);
                }
                if (msg.stateRevision < last_highlight_state_revision_ref.current) {
                    // A superseded reply still resolves this panel's own pending
                    // request, so its status must not stay stuck on "Updating…".
                    if (matching_request) {
                        if (msg.error) {
                            set_highlight_status(msg.error);
                            host_bridge.postMessage({ type: 'showWarning', message: msg.error });
                        } else {
                            set_highlight_status('Cell highlights updated.');
                        }
                    }
                    return;
                }
                last_highlight_state_revision_ref.current = msg.stateRevision;
                state_ref.current = {
                    ...state_ref.current,
                    cellHighlights: msg.state,
                };
                set_cell_highlights(msg.state);
                if (msg.error) {
                    set_highlight_status(msg.error);
                    host_bridge.postMessage({ type: 'showWarning', message: msg.error });
                } else {
                    set_highlight_status(msg.requestId ? 'Cell highlights updated.' : 'Cell highlights refreshed.');
                }
            }

            if (msg.type === 'filterHistogram') {
                const pending = pending_histogram_ref.current;
                if (!pending || pending.requestId !== msg.requestId) return;
                if (
                    pending.sheetIndex !== msg.sheetIndex
                    || pending.columnIndex !== msg.columnIndex
                    || pending.generation !== msg.generation
                    || pending.sourceGeneration !== msg.sourceGeneration
                    || source_generation_ref.current !== msg.sourceGeneration
                ) return;
                pending_histogram_ref.current = null;
                if (msg.error) {
                    set_filter_histogram({
                        key: pending.key,
                        value: { status: 'error', message: msg.error },
                    });
                } else {
                    const ready: FilterHistogramReady = {
                        bins: msg.bins,
                        columnKind: msg.columnKind ?? 'unknown',
                        distinctValues: msg.distinctValues,
                        distinctValuesExceeded: msg.distinctValuesExceeded,
                    };
                    histogram_cache_ref.current.set(pending.key, ready);
                    set_filter_histogram({
                        key: pending.key,
                        value: { status: 'ready', ...ready },
                    });
                }
            }

            if (msg.type === 'saveOperationStarted') {
                apply_save_lifecycle(msg.lifecycle);
            }

            if (msg.type === 'workbookSnapshot') {
                const { snapshot } = msg;
                const previous_native_identity = last_applied_snapshot_ref.current;
                const cross_file_initial = snapshot.presentation === 'initial'
                    && previous_native_identity !== null
                    && previous_native_identity.authority.fileId
                        !== snapshot.identity.authority.fileId;
                const disposition = classify_snapshot(
                    snapshot.identity,
                    last_applied_snapshot_ref.current,
                );
                if (cross_file_initial && disposition === 'applied') {
                    reset_save_projection();
                    pending_excel_header_ref.current = null;
                    pending_excel_header_unhide_ref.current = false;
                    pending_excel_header_promote_ref.current = false;
                    set_pending_excel_header(null);
                    set_excel_header_status('');
                }
                const same_file = previous_native_identity?.authority.fileId
                    === snapshot.identity.authority.fileId;
                // Save lifecycle authority has its own monotonic clock. A stale
                // workbook projection from the current file may still carry the
                // terminal save state that this receiver otherwise missed.
                const save_transition = disposition === 'applied' || same_file
                    ? apply_save_lifecycle(
                        snapshot.capabilities.csvSaveLifecycle,
                    )
                    : undefined;
                const process_command_result = (
                    result: RetainedSnapshotCommandResult | undefined,
                ) => {
                    if (!result) return;
                    const key = `${result.type}:${result.requestId}`;
                    if (processed_snapshot_results_ref.current.has(key)) return;
                    processed_snapshot_results_ref.current.add(key);
                    while (processed_snapshot_results_ref.current.size > 128) {
                        const oldest = processed_snapshot_results_ref.current.values().next().value;
                        if (oldest === undefined) break;
                        processed_snapshot_results_ref.current.delete(oldest);
                    }
                    if (
                        result.type !== 'excelFirstRowHeader'
                        || pending_excel_header_ref.current !== result.requestId
                    ) return;
                    const restoring_rows = pending_excel_header_unhide_ref.current;
                    const promoting_row = pending_excel_header_promote_ref.current;
                    pending_excel_header_ref.current = null;
                    pending_excel_header_unhide_ref.current = false;
                    pending_excel_header_promote_ref.current = false;
                    set_pending_excel_header(null);
                    if (result.outcome === 'rejected') {
                        set_excel_header_status(restoring_rows
                            ? 'Rows were not restored.'
                            : promoting_row
                            ? 'Header row was not updated.'
                            : 'Column names were not updated.');
                        if (result.error) {
                            host_bridge.postMessage({
                                type: 'showWarning',
                                message: restoring_rows
                                    ? `Could not restore rows: ${result.error}`
                                    : `Could not change the header row: ${result.error}`,
                            });
                        }
                    } else if (result.outcome === 'recovered') {
                        set_excel_header_status(
                            restoring_rows
                                ? 'Rows were restored, but recovery was required.'
                                : promoting_row
                                ? 'Header row was updated, but recovery was required.'
                                : 'Column names were updated, but recovery was required.',
                        );
                        if (result.error) {
                            host_bridge.postMessage({
                                type: 'showWarning',
                                message: restoring_rows
                                    ? `The rows were restored after recovery: ${result.error}`
                                    : `The header setting was saved after recovery: ${result.error}`,
                            });
                        }
                    } else {
                        set_excel_header_status(
                            restoring_rows
                                ? 'Rows restored.'
                                : promoting_row
                                ? 'Header row updated.'
                                : 'Column names updated.',
                        );
                    }
                };

                // Retained results are independently idempotent: a duplicate or
                // stale snapshot can still finish its matching command without
                // rehydrating or regressing the UI.
                process_command_result(snapshot.commandResult);

                if (disposition === 'applied') {
                    // Every applied snapshot is lifecycle-relevant, including the
                    // first snapshot for a newly selected file.
                    const applied_save_transition = save_transition!;
                    last_applied_snapshot_ref.current = snapshot.identity;
                    // Fold the open overlay into the store before this snapshot's
                    // generation bump unmounts the grid that owns it. Ahead of both
                    // installs below on purpose: an install carrying authoritative
                    // absence must still win over a folded overlay, since the
                    // refresh owns the complete pending-edit projection. The fold's
                    // value is the refresh where refresh_editing_current_session is
                    // false and therefore nothing installs. Only on the applied
                    // branch — a duplicate or stale snapshot must not touch edit
                    // state at all.
                    //
                    // And only when this snapshot actually remounts, which is the same
                    // discriminator round 4 established for the transform ack: the
                    // fold exists because the remount destroys the grid that owns the
                    // overlay, so a snapshot that remounts nothing has nothing to
                    // rescue and folding for it commits a value the user never
                    // confirmed, past the point where Escape could take it back. The
                    // predicate is GridShell's remount key: `generation` (still the
                    // previous one here), `load_epoch` — which only an 'initial'
                    // snapshot bumps — and the active sheet, which a refresh can move
                    // only by clamping to a shrunken sheet list. A same-basis refresh
                    // is the common case by far, since every edit commit during an
                    // owned session and every sibling touch of durable state delivers
                    // one.
                    const previous_sheets = meta_ref.current?.sheets ?? [];
                    const next_sheets = snapshot.meta.sheets;
                    const sheets_moved = previous_sheets.length !== next_sheets.length
                        || previous_sheets.some((sheet, index) => {
                            const next = next_sheets[index];
                            return next === undefined
                                || (sheet.worksheetId !== undefined
                                    ? sheet.worksheetId !== next.worksheetId
                                    : sheet.name !== next.name);
                        });
                    const next_active_sheet_index = clamp_sheet_index(
                        active_sheet_index,
                        snapshot.meta.sheets.length,
                    );
                    const previous_active_sheet = previous_sheets[active_sheet_index];
                    const next_active_sheet = next_sheets[next_active_sheet_index];
                    const active_sheet_changed = previous_active_sheet?.worksheetId !== undefined
                        ? previous_active_sheet.worksheetId !== next_active_sheet?.worksheetId
                        : previous_active_sheet?.name !== next_active_sheet?.name;
                    const remounts_the_grid =
                        snapshot.presentation === 'initial'
                        || snapshot.generation !== generation_ref.current
                        || next_active_sheet_index !== active_sheet_index
                        || active_sheet_changed;
                    if (active_sheet_changed) {
                        editing_ref.current?.flush_live_edit();
                    } else if (remounts_the_grid) {
                        editing_ref.current?.commit_live_edit();
                    }
                    snapshot_identity_ref.current = snapshot.identity;
                    const previous_sheets_by_name = new Map(
                        previous_sheets.map((sheet) => [sheet.name, sheet]),
                    );
                    const header_changed = new Set<number>();
                    snapshot.meta.sheets.forEach((sheet, index) => {
                        const previous = previous_sheets_by_name.get(sheet.name);
                        if (
                            previous
                            && (
                                previous.excelFirstRowHeader?.active
                                    !== sheet.excelFirstRowHeader?.active
                                || previous.excelFirstRowHeader?.sourceRow
                                    !== sheet.excelFirstRowHeader?.sourceRow
                            )
                        ) {
                            header_changed.add(index);
                        }
                    });
                    // Capture authoritative edits before generation/source updates
                    // can remount the grid.
                    const refresh_authoritative_state =
                        snapshot.presentation === 'refresh'
                            ? normalize_workbook_snapshot_state(
                                snapshot.state,
                                snapshot.meta,
                            )
                            : undefined;
                    // Normalization derives the current renderable highlight
                    // projection, so compute it once for the 'initial' branch.
                    const initial_normalized_state = snapshot.presentation === 'initial'
                        ? normalize_workbook_snapshot_state(
                            snapshot.state,
                            snapshot.meta,
                        )
                        : undefined;
                    const incoming_snapshot_highlights = snapshot.presentation === 'refresh'
                        ? refresh_authoritative_state!.cellHighlights
                        : initial_normalized_state!.cellHighlights;
                    const install_snapshot_highlights = snapshot.presentation === 'initial'
                        || snapshot.identity.stateRevision
                            >= last_highlight_state_revision_ref.current;
                    const snapshot_highlights = install_snapshot_highlights
                        ? incoming_snapshot_highlights
                        : state_ref.current.cellHighlights;
                    if (install_snapshot_highlights) {
                        last_highlight_state_revision_ref.current = snapshot.identity.stateRevision;
                        set_cell_highlights(snapshot_highlights);
                    }
                    const snapshot_edit_session_id =
                        snapshot.capabilities.csvEditSessionId;
                    const refresh_edits_for_sheet = (sheet_index: number) => (
                        snapshot.presentation === 'refresh'
                            ? resolve_csv_save_hydration(
                                applied_save_transition.next,
                                snapshot_edit_session_id,
                                sheet_index,
                                snapshot.meta.sheets[sheet_index]?.name,
                                snapshot.meta.sheets[sheet_index]?.worksheetId,
                                pending_edits_for_sheet(
                                    refresh_authoritative_state?.pendingEdits,
                                    sheet_index,
                                    snapshot.meta.sheets[sheet_index]?.name,
                                    snapshot.meta.sheets[sheet_index]?.worksheetId,
                                ),
                            )
                            : undefined
                    );
                    // Reconcile the registry at the snapshot itself, not in
                    // install_edit_session: a refresh that advances the session
                    // id makes `refresh_editing_current_session` false and skips
                    // the install entirely, and that is exactly a path where the
                    // sheets may have moved. The session is workbook-scoped, so
                    // any sheet's store may hold edits: an initial snapshot
                    // replaces the document and owns the complete pending-edit
                    // projection, so every store goes; a refresh moves each
                    // store to wherever its worksheet went, resolved by name
                    // against the meta this handler has not yet replaced. A
                    // sheet whose name no longer resolves was deleted, and its
                    // in-memory store goes with it — the durable slot is what
                    // survives a deletion-shaped rename.
                    const followed_sheet_index = (previous_index: number) => {
                        const previous = previous_sheets[previous_index];
                        if (!previous) return undefined;
                        return worksheet_target_index(next_sheets, {
                            sheetIndex: previous_index,
                            sheetName: previous.name,
                            worksheetId: previous.worksheetId,
                        });
                    };
                    let locally_retained_sheet_indices: ReadonlySet<number> = new Set();
                    if (snapshot.presentation === 'initial') {
                        edit_session_registry_ref.current!.replace_document();
                    } else {
                        const edit_session_id = csv_edit_session_id_ref.current;
                        const reconciliation = edit_session_registry_ref.current!
                            .reconcile_sheets(
                                previous_sheets,
                                next_sheets,
                                (target, store) => !!edit_session_id && (
                                    sheets_moved
                                        ? store.size() > 0
                                            || pending_edit_durability.has_publication(
                                                edit_session_id,
                                                target.sheetIndex,
                                                target.sheetName,
                                                target.worksheetId,
                                            )
                                        : pending_edit_durability.has_unacknowledged_payload(
                                            edit_session_id,
                                            target.sheetIndex,
                                            target.sheetName,
                                            target.worksheetId,
                                        )
                                ),
                            );
                        locally_retained_sheet_indices =
                            reconciliation.locallyRetainedIndices;

                        // Every refresh changes the host authority revision and can
                        // abort a publication admitted against the preceding one.
                        // Retry each retained store's complete truth, including an
                        // explicit null after the last edit was cleared. Returned
                        // stores are already reattached, so there is only one owner.
                        //
                        // A snapshot that already contains the latest publication is
                        // proof that this particular write crossed the durable boundary.
                        // Its explicit acknowledgement is queued behind the snapshot, so
                        // force-publishing here would create a feedback loop: every retry
                        // commits another snapshot before its own acknowledgement arrives.
                        // Keep the local store retained until the acknowledgement, but do
                        // not retry truth the host has just projected back verbatim.
                        if (edit_session_id) {
                            for (const { target, store } of
                                reconciliation.retryPublications) {
                                const store_snapshot = store.snapshot();
                                const authoritative_edits =
                                    refresh_edits_for_sheet(target.sheetIndex);
                                if (pending_edit_durability.unacknowledged_payload_matches(
                                    edit_session_id,
                                    authoritative_edits ?? null,
                                    target.sheetIndex,
                                    target.sheetName,
                                    target.worksheetId,
                                )) continue;
                                pending_edit_durability.publish(
                                    edit_session_id,
                                    store_snapshot.size > 0
                                        ? Object.fromEntries(store_snapshot)
                                        : null,
                                    target.sheetIndex,
                                    target.sheetName,
                                    true,
                                    target.worksheetId,
                                );
                            }
                        }
                    }
                    // Where the edit pointer stands after this snapshot. A refresh
                    // of the session this panel already holds keeps the pointer on
                    // the sheet the user is editing — followed by name if the
                    // sheets moved — rather than retargeting to whichever slot
                    // happens to be dirty first; the user chose that sheet, and a
                    // sibling's durable write must not yank the session off it.
                    // The dirty-slot scan is the fallback for a snapshot with no
                    // pointer of this panel's to preserve: adoption, reload, a
                    // restored window — or a pointer sheet the refresh deleted.
                    const session_continues = snapshot.presentation === 'refresh'
                        && csv_edit_session_id_ref.current !== undefined
                        && csv_edit_session_id_ref.current === snapshot_edit_session_id;
                    const pointer_followed = session_continues
                        ? (!sheets_moved
                            ? edit_session_sheet_index_ref.current
                            : followed_sheet_index(edit_session_sheet_index_ref.current))
                        : undefined;
                    const snapshot_pending_edits = snapshot.presentation === 'refresh'
                        ? refresh_authoritative_state?.pendingEdits
                        : initial_normalized_state?.pendingEdits;
                    const pending_edit_sheet_index = sheet_index_with_pending_edits(
                        snapshot_pending_edits,
                        next_sheets,
                    );
                    const pointer_deleted = session_continues
                        && sheets_moved
                        && pointer_followed === undefined;
                    const fallback_sheet_index = clamp_sheet_index(
                        edit_session_sheet_index_ref.current,
                        next_sheets.length,
                    );
                    const snapshot_edit_sheet_index = pointer_followed
                        ?? pending_edit_sheet_index
                        ?? fallback_sheet_index;
                    edit_session_sheet_index_ref.current = snapshot_edit_sheet_index;
                    const refresh_editing_current_session =
                        snapshot.presentation === 'refresh'
                        && edit_mode_ref.current
                        && csv_edit_session_id_ref.current === snapshot_edit_session_id
                        && (!pointer_deleted || pending_edit_sheet_index !== undefined);
                    if (pointer_deleted && pending_edit_sheet_index === undefined) {
                        edit_mode_ref.current = false;
                        set_edit_mode(false);
                    }
                    const refresh_edits = refresh_edits_for_sheet(snapshot_edit_sheet_index);
                    if (refresh_editing_current_session) {
                        if (!locally_retained_sheet_indices.has(snapshot_edit_sheet_index)) {
                            edit_session_registry_ref.current!
                                .for_sheet(snapshot_edit_sheet_index)
                                .reconcile(
                                    { session_id: snapshot_edit_session_id },
                                    refresh_edits,
                                );
                        }
                        // A refresh carries the complete authoritative workbook
                        // leaf. Reconcile every store already known to the session,
                        // plus every newly projected slot, so recovered sibling
                        // drafts appear and removed slots cannot remain stale.
                        const refresh_sheet_indices = new Set<number>();
                        for (const [index] of edit_session_registry_ref.current!.entries()) {
                            refresh_sheet_indices.add(index);
                        }
                        refresh_authoritative_state?.pendingEdits?.forEach(
                            (slot, index) => {
                                if (slot !== undefined) refresh_sheet_indices.add(index);
                            },
                        );
                        for (const sheet_index of refresh_sheet_indices) {
                            if (
                                sheet_index === snapshot_edit_sheet_index
                                || locally_retained_sheet_indices.has(sheet_index)
                            ) continue;
                            edit_session_registry_ref.current!
                                .for_sheet(sheet_index)
                                .reconcile(
                                    { session_id: snapshot_edit_session_id },
                                    refresh_edits_for_sheet(sheet_index),
                                );
                        }
                    }
                    document_epoch_ref.current += 1;
                    set_grid_focus_restore(null);
                    set_toolbar_focus_restore(null);
                    if (snapshot.presentation === 'initial') {
                        last_preview_visible_row_ref.current = null;
                        clear_pending_preview_scroll();
                    } else if (
                        preview_mode_ref.current
                        && pending_preview_scroll_ref.current === null
                        && last_preview_visible_row_ref.current !== null
                    ) {
                        queue_preview_scroll(last_preview_visible_row_ref.current);
                    }
                    preview_mode_ref.current = snapshot.configuration.previewMode;
                    set_preview_mode(snapshot.configuration.previewMode);
                    meta_ref.current = snapshot.meta;
                    set_meta(snapshot.meta);
                    set_filter_editor(null);
                    const source_changed =
                        snapshot.presentation === 'initial'
                        || source_generation_ref.current !== snapshot.sourceGeneration;
                    if (source_changed) {
                        histogram_cache_ref.current.clear();
                        set_filter_histogram({ key: '', value: { status: 'loading' } });
                    }
                    const view_generation_changed =
                        generation_ref.current !== snapshot.generation;
                    const previous_mapping_generations = mapping_generations_ref.current;
                    const changed_mapping_indices = new Set<number>();
                    const mapping_count = Math.max(
                        previous_mapping_generations.length,
                        snapshot.mappingGenerations.length,
                    );
                    for (let index = 0; index < mapping_count; index += 1) {
                        if (
                            previous_mapping_generations[index]
                            !== snapshot.mappingGenerations[index]
                        ) changed_mapping_indices.add(index);
                    }
                    mapping_generations_ref.current = [...snapshot.mappingGenerations];
                    set_generation(snapshot.generation);
                    generation_ref.current = snapshot.generation;
                    source_generation_ref.current = snapshot.sourceGeneration;
                    if (snapshot.presentation === 'initial') {
                        pending_highlight_request_ref.current = null;
                        set_highlight_request_pending(false);
                        set_highlight_status('');
                        set_highlight_selection_available(false);
                        set_edit_session_pending(false);
                        pending_edit_request_ref.current = null;
                        pending_save_dialog_ref.current = null;
                    }
                    set_source_epoch((n) => n + 1);
                    // What the rows *are* changes with a new source, a new view
                    // generation (durable transform reconciliation bumps the
                    // generation without the source, and reports it only here), or a
                    // changed header row — and with nothing else. A same-generation
                    // capability refresh, which entering edit mode and every
                    // edit-store notification during an owned session redeliver,
                    // leaves the rows exactly where they were.
                    const row_basis_changed =
                        source_changed
                        || view_generation_changed
                        || header_changed.size > 0;
                    // Auto-fit measurements are per sheet. A source replacement may
                    // reorder or replace every bare queue index, so fail closed for the
                    // whole workbook. Within the same source, mapping generations and
                    // header changes identify exactly the sheets whose sampled rows changed.
                    const invalid_auto_fit_sheets = new Set([
                        ...changed_mapping_indices,
                        ...header_changed,
                    ]);
                    if (source_changed) {
                        auto_fit_active_ref.current = [];
                        auto_fit_snapshot_ref.current = [];
                        set_auto_fit_active([]);
                        set_auto_fit_snapshot([]);
                        update_pending_auto_fit_sheets(EMPTY_PENDING_AUTO_FIT);
                    } else if (invalid_auto_fit_sheets.size > 0) {
                        const next_active = auto_fit_active_ref.current
                            .map((active, index) => (
                                invalid_auto_fit_sheets.has(index) ? false : active
                            ));
                        const next_snapshot = auto_fit_snapshot_ref.current
                            .map((saved, index) => (
                                invalid_auto_fit_sheets.has(index) ? undefined : saved
                            ));
                        auto_fit_active_ref.current = next_active;
                        auto_fit_snapshot_ref.current = next_snapshot;
                        set_auto_fit_active(next_active);
                        set_auto_fit_snapshot(next_snapshot);
                        update_pending_auto_fit_sheets((prev) => {
                            const next = new Set(prev);
                            invalid_auto_fit_sheets.forEach((index) => next.delete(index));
                            return next.size === prev.size ? prev : next;
                        });
                    }
                    if (snapshot.presentation === 'refresh' && !source_changed) {
                        // The refresh reinstalls the host's authoritative widths, which
                        // can predate this panel's own fitted-width write. Any differing
                        // width supersedes both a completed fit and a still-owed fit.
                        const incoming = refresh_authoritative_state!.columnWidths;
                        const local = state_ref.current.columnWidths ?? [];
                        const width_count = Math.max(incoming.length, local.length);
                        const changed_widths = Array.from(
                            { length: width_count },
                            (_unused, index) => !sheet_widths_equal(
                                incoming[index],
                                local[index],
                            ),
                        );
                        const stale = auto_fit_active_ref.current
                            .map((active, index) => active && changed_widths[index]);
                        if (stale.some(Boolean)) {
                            const next_active = auto_fit_active_ref.current
                                .map((active, index) => active && !stale[index]);
                            const next_snapshot = auto_fit_snapshot_ref.current
                                .map((saved, index) => (
                                    stale[index] ? undefined : saved
                                ));
                            auto_fit_active_ref.current = next_active;
                            auto_fit_snapshot_ref.current = next_snapshot;
                            set_auto_fit_active(next_active);
                            set_auto_fit_snapshot(next_snapshot);
                        }
                        if (changed_widths.some(Boolean)) {
                            update_pending_auto_fit_sheets((prev) => {
                                const next = new Set(prev);
                                changed_widths.forEach((changed, index) => {
                                    if (changed) next.delete(index);
                                });
                                return next.size === prev.size ? prev : next;
                            });
                        }
                    }
                    // An in-flight transform is only invalidated by a snapshot that
                    // changes the rows it is being computed over; on the same row
                    // basis it is still going to answer, and its requestId is the
                    // only thing the install/refusal guards can match on. Dropping
                    // the id here would make the host's ack fail that guard and be
                    // discarded, leaving this webview on a generation the host has
                    // already left behind — every row request it sends afterwards is
                    // then refused. That is reachable now that a transform may be in
                    // flight during an owned edit session, where committing an edit
                    // makes the host redeliver the projection at the same generation.
                    if (row_basis_changed) {
                        set_pending_transforms([]);
                        set_pending_transform_labels([]);
                        pending_transform_request_ids_ref.current = [];
                        pending_transform_states_ref.current = [];
                        pending_transform_origins_ref.current = [];
                        // Different rows mean the earlier refusal was about a basis
                        // that no longer exists, and the permutation the host dropped
                        // has to be asked for again regardless of what is blocking.
                        restore_request_blockers_ref.current = [];
                    }
                    // Deliberately NOT gated on row_basis_changed, unlike the
                    // in-flight bookkeeping above and the view records below: a sheet
                    // that could not support its saved transform a moment ago may be
                    // able to now — different columns, a different header row — and
                    // this snapshot is the only place that news arrives.
                    restore_abandoned_ref.current = [];

                    let correction_required = false;
                    if (snapshot.presentation === 'initial') {
                        set_load_epoch((n) => n + 1);
                        const normalized = initial_normalized_state!;
                        const base = normalize_complete_per_file_state(
                            snapshot.state,
                            snapshot.meta.sheets,
                        );
                        correction_required = JSON.stringify({
                            transforms: base.transforms ?? [],
                            columnVisibility: base.columnVisibility ?? [],
                            cellHighlights: base.cellHighlights,
                        }) !== JSON.stringify({
                            transforms: normalized.transforms,
                            columnVisibility: normalized.columnVisibility,
                            cellHighlights: normalized.cellHighlights,
                        });
                        set_active_sheet_index(normalized.activeSheetIndex);
                        set_column_widths(normalized.columnWidths);
                        set_show_formatting_by_sheet(normalized.showFormatting ?? []);
                        // Header work owed to the *previous* document is keyed by bare
                        // sheet index, so it cannot cross this boundary. Pending auto-fit
                        // was already cleared with the changed row basis above.
                        set_excel_header_queue(null);
                        set_column_visibility(normalized.columnVisibility);
                        set_transforms(normalized.transforms);
                        const tab_orient = normalized.tabOrientation;
                        set_vertical_tabs(
                            tab_orient !== null
                                ? tab_orient === 'vertical'
                                : snapshot.configuration.defaultTabOrientation === 'vertical',
                        );
                        state_ref.current = normalized;
                        const restored_edits = resolve_csv_save_hydration(
                            applied_save_transition.next,
                            snapshot_edit_session_id,
                            snapshot_edit_sheet_index,
                            snapshot.meta.sheets[snapshot_edit_sheet_index]?.name,
                            snapshot.meta.sheets[snapshot_edit_sheet_index]?.worksheetId,
                            pending_edits_for_sheet(
                                normalized.pendingEdits,
                                snapshot_edit_sheet_index,
                                snapshot.meta.sheets[snapshot_edit_sheet_index]?.name,
                                snapshot.meta.sheets[snapshot_edit_sheet_index]?.worksheetId,
                            ),
                        );
                        const exact_session_succeeded =
                            applied_save_transition.next.authoritative.state === 'succeeded'
                            && applied_save_transition.next.authoritative.operation.editSessionId
                                === snapshot_edit_session_id;
                        const owns_clean_or_dirty_session =
                            snapshot_edit_session_id !== undefined
                            && snapshot.capabilities.csvEditable
                            && !exact_session_succeeded;
                        const hydrated_edits = owns_clean_or_dirty_session
                            ? restored_edits ?? {}
                            : restored_edits;
                        install_edit_session(
                            hydrated_edits,
                            snapshot_edit_session_id,
                        );
                        // The session covers the whole workbook, so restored
                        // edits can sit in any sheet's slot, not just the
                        // pointer sheet's. Seed each one's registry store directly.
                        normalized.pendingEdits?.forEach((_slot, index) => {
                            if (index === snapshot_edit_sheet_index) return;
                            const sheet = snapshot.meta.sheets[index];
                            const cells = resolve_csv_save_hydration(
                                applied_save_transition.next,
                                snapshot_edit_session_id,
                                index,
                                sheet?.name,
                                sheet?.worksheetId,
                                pending_edits_for_sheet(
                                    normalized.pendingEdits,
                                    index,
                                    sheet?.name,
                                    sheet?.worksheetId,
                                ),
                            );
                            if (!cells) return;
                            edit_session_registry_ref.current!
                                .for_sheet(index)
                                .install(
                                    { session_id: snapshot_edit_session_id },
                                    cells,
                                );
                        });
                        set_edit_mode(
                            owns_clean_or_dirty_session
                            || restored_edits !== undefined,
                        );
                        set_editing_status(null);
                        // A fresh document: the rejection and the dismissal go
                        // together. The install above deliberately does not clear the
                        // verdict (a same-session refresh reinstalls the very map the
                        // host judged), so this is the clear for the reset — and it
                        // was already written to stand on its own rather than depend
                        // on that call's internals.
                        clear_save_verdict();
                        pending_exit_ref.current = false;
                    } else {
                        const sheet_count = snapshot.meta.sheets.length;
                        const authoritative_state = refresh_authoritative_state!;
                        const next_column_widths = trim_sheet_state_array(
                            authoritative_state.columnWidths,
                            sheet_count,
                        );
                        // No `rowHeights` clearing beside the scroll clearing below any
                        // more, and the asymmetry is the point. A scroll offset is in
                        // pixels down a particular arrangement of rows, so a promotion
                        // that removes a row genuinely invalidates it. Heights are keyed
                        // by canonical source row, which a promotion does not renumber:
                        // the promoted row simply stops having a display row, and
                        // `display_row_for_source` accounts for the one-row shift in
                        // every projection the host sends afterwards.
                        const next_scroll_position = trim_sheet_state_array(
                            authoritative_state.scrollPosition,
                            sheet_count,
                        ).map((value, index) => (
                            header_changed.has(index) ? undefined : value
                        ));
                        const next_transforms = snapshot.meta.sheets.map((sheet, index) =>
                            sanitize_transform_state(
                                authoritative_state.transforms[index],
                                sheet.columnCount,
                                transform_schema_for_sheet(sheet),
                                sheet.sourceRowCount,
                            ));
                        const next_column_visibility = snapshot.meta.sheets.map(
                            (sheet, index) => sanitize_column_visibility_state(
                                authoritative_state.columnVisibility[index],
                                sheet.columnCount,
                                transform_schema_for_sheet(sheet),
                            ),
                        );
                        const next_active_sheet_index = clamp_sheet_index(
                            active_sheet_index,
                            sheet_count,
                        );
                        // `rowHeights` is not compared, and there is nothing left to
                        // compare: the field is absent from `NormalizedPerFileState`, so
                        // no delivery carries the durable map and this panel holds no copy
                        // of it. Even if one arrived, heights are not a patch leaf any
                        // more, so a difference could produce nothing but an empty patch.
                        correction_required = JSON.stringify({
                            scrollPosition: authoritative_state.scrollPosition,
                            transforms: authoritative_state.transforms,
                            columnVisibility: authoritative_state.columnVisibility,
                            cellHighlights: snapshot.state.cellHighlights,
                        }) !== JSON.stringify({
                            scrollPosition: next_scroll_position,
                            transforms: next_transforms,
                            columnVisibility: next_column_visibility,
                            cellHighlights: authoritative_state.cellHighlights,
                        });
                        set_column_widths(next_column_widths);
                        set_transforms(next_transforms);
                        set_column_visibility(next_column_visibility);
                        set_active_sheet_index(next_active_sheet_index);
                        state_ref.current = {
                            ...state_ref.current,
                            ...authoritative_state,
                            columnWidths: next_column_widths,
                            // No `rowHeights` anywhere in here, and nothing to strip
                            // either: the delivered state has no such field
                            // (`NormalizedPerFileState` omits it), so the spread above
                            // cannot bring one in and the `stateChanged` this ref feeds
                            // cannot carry one out. The durable, source-keyed map lives
                            // only on the host; this panel renders from
                            // `rowHeightProjection`.
                            scrollPosition: next_scroll_position,
                            transforms: next_transforms,
                            columnVisibility: next_column_visibility,
                            cellHighlights: snapshot_highlights,
                            activeSheetIndex: authoritative_state.activeSheetIndex,
                            // Back into the owning sheet's slot: this ref mirrors the
                            // whole-workbook leaf, while the hydration above works in
                            // one sheet's key space.
                            ...(refresh_editing_current_session
                                ? {
                                    pendingEdits: with_pending_edits_for_sheet(
                                        authoritative_state.pendingEdits,
                                        edit_session_sheet_index_ref.current,
                                        refresh_edits,
                                        snapshot.meta.sheets[
                                            edit_session_sheet_index_ref.current
                                        ]?.name,
                                        snapshot.meta.sheets[
                                            edit_session_sheet_index_ref.current
                                        ]?.worksheetId,
                                    ),
                                }
                                : {}),
                        };
                    }
                    // The whole of this snapshot's effect on what view is installed,
                    // as one decision per sheet. The basis is derived the way the host
                    // derives it in `PanelCore.installed_view`, and a record whose
                    // basis matches describes rows this snapshot did not move: it
                    // stands, entirely. A record whose basis differs describes rows
                    // that no longer exist, so it is replaced, entirely, by the
                    // natural view this snapshot does describe.
                    //
                    // Both halves are load-bearing, and splitting them is what three
                    // of this PR's findings were. Keeping a stale record would make
                    // `transform_active` read true over rows the host has re-read.
                    // Dropping a live one would make it read false while the loader is
                    // still permuted, which un-suppresses the display-keyed row-height
                    // affordances (the resize overlay, hover-arming, multiline
                    // auto-grow) and lets a height be persisted for the wrong row —
                    // durable corruption, not a flicker. Every edit commit during an
                    // owned session redelivers a same-basis refresh, so that second
                    // case is the common one.
                    //
                    // `header_changed` is not consulted: an Excel promotion reaches
                    // the view only through adopt_source, which bumps both
                    // generations, and it names the promoted row in the schema too — so
                    // the basis has already caught it. Its other use in the refresh
                    // branch above, clearing that sheet's stored heights and scroll
                    // offset, is a different concern.
                    //
                    // A retained record deliberately does NOT take its rules from
                    // this snapshot's durable state. The two are different facts: a
                    // sibling panel can change the durable rules with no generation
                    // movement at all, and a same-basis refresh is exactly how that
                    // arrives. The record saying what *we* still hold is what lets the
                    // restore effect see the difference and reconcile it.
                    //
                    // Sound only because a retained record's rules are read as a
                    // *description of these rows* and never as the user's current
                    // intent: keeping them is licensed by the basis, which is evidence
                    // about the permutation they describe and about nothing else. The
                    // one reader that wanted intent — Cancel's rollback baseline —
                    // reads durable state live for exactly this reason.
                    //
                    // Its hidden edited cells are the one exception, and the exception
                    // is not about durable *rules* at all — it is the host's live
                    // answer about the permutation this record already describes, and
                    // the only field of the record a delivery that moved no row can
                    // have news about. See `view_record_with_hidden_keys`.
                    set_sheet_views((previous) => snapshot.meta.sheets.map(
                        (sheet, index) => {
                            const basis = {
                                generation: snapshot.generation,
                                sourceGeneration: snapshot.sourceGeneration,
                                schema: transform_schema_for_sheet(sheet),
                            };
                            const held = previous[index];
                            if (
                                // A new document restarts from the host's own
                                // counters, so equal generations here are a
                                // coincidence rather than evidence about the rows.
                                snapshot.presentation === 'refresh'
                                && held
                                && view_bases_equal(held.basis, basis)
                            ) {
                                return view_record_with_hidden_keys(
                                    held,
                                    snapshot.hiddenEditedCellKeys[index] ?? [],
                                );
                            }
                            // The natural view: the host installs no permutation for a
                            // basis it has just read (matching schema does not imply
                            // matching values), so an active transform has to be
                            // re-requested and until it lands the rows are the
                            // metadata's own.
                            //
                            // Which is why this is the `permuted: false` arm and there
                            // is nothing else to fill in. No rules — not even the
                            // durable definitions a filter the user switched off leaves
                            // behind — because this branch asserts that nothing is
                            // installed, and a record naming them anyway would be
                            // holding a copy of durable intent that basis equality never
                            // licensed keeping. Cancel used to read that copy as its
                            // rollback baseline; it now reads the intent live, which is
                            // the only way to see a sibling that replaced or removed a
                            // disabled definition without moving a row.
                            //
                            // And no hidden edited cells, which used to be a fabricated
                            // `[]` here: a view containing every row hides no edit, and
                            // adopting `snapshot.hiddenEditedCellKeys` instead — which
                            // the delivery does carry, about whatever permutation the
                            // host holds — would have made the record self-contradictory.
                            // Both mistakes are now unwritable rather than commented
                            // against; see the rule on `SheetViewRecord`.
                            return { basis, permuted: false, rowCount: sheet.rowCount };
                        },
                    ));
                    // The height projection, adopted whole from every delivery and from
                    // both branches — the opposite treatment to the view records above,
                    // and for the opposite reason. A record is retained on a matching
                    // basis because it is a statement about rows that this snapshot did
                    // not move. The projection is a *join* of that permutation with
                    // durable intent, and the durable side moves with no basis change at
                    // all: a sibling panel's write, another `setRowHeights`, an
                    // excel-header plan edit. A retained projection would therefore go
                    // stale invisibly, so there is nothing to retain — the host samples
                    // it live and synchronously for every delivery, in the same instant
                    // as `snapshot.generation`, and the two can never name different
                    // permutations.
                    const next_row_height_projection = trim_sheet_state_array(
                        [...snapshot.rowHeightProjection],
                        snapshot.meta.sheets.length,
                    );
                    set_row_height_projection(next_row_height_projection);
                    // And the resizes this panel has posted but not yet seen back. Two
                    // independent reasons to void one, and then a reconciliation, asked of
                    // *every* sheet's overlay rather than of one: a delivery is a statement
                    // about the whole workbook, and two sheets can each be waiting on a
                    // resize at the same time.
                    //
                    // A new document voids all of them here rather than through the shared
                    // rule: a fresh document restarts the host's counters, so every
                    // generation comparison below would be a coincidence rather than
                    // evidence, the same reason `presentation === 'refresh'` gates the record
                    // retention above.
                    //
                    // Otherwise the shared rule decides, and this delivery is the reason
                    // `mappingGenerations` is on the wire at all. Asking `previous
                    // .generation !== snapshot.generation` — which is what this did — is
                    // the mistake the host had already been fixed out of: a terminal
                    // transform reconciliation for *another* sheet bumps the core-wide
                    // generation while rewriting only that sheet's indices, so it threw
                    // away an overlay whose display rows had not moved, while the host,
                    // asking the scoped question, accepted the very write it belonged to.
                    // Unlike `transformInstalled` a snapshot names no sheet, which is why
                    // the sheet-scoped fact had to be delivered rather than inferred; the
                    // `sourceGeneration` inference that would have avoided that is unsound
                    // and the argument is at `retained_row_height_overlay`.
                    //
                    // What survives is reconciled by value — a layer the delivered
                    // projection already agrees with has been answered, and must be
                    // dropped, along with every layer older than it, which the serialized
                    // host write order proves is already dead — so that a *later* height
                    // for those rows is not masked for the rest of the generation. Value,
                    // not a request id, because nothing correlates a `setRowHeights` with
                    // the delivery that answers it and nothing needs to. In full at
                    // `row_height_layers_for_delivery`.
                    set_row_height_overlay((previous) => {
                        if (snapshot.presentation === 'initial') {
                            return NO_ROW_HEIGHT_OVERLAYS;
                        }
                        return mapped_row_height_overlays(
                            previous,
                            (overlay, sheet_index) => {
                                const retained = retained_row_height_overlay(
                                    overlay,
                                    snapshot.generation,
                                    snapshot.mappingGenerations[sheet_index],
                                );
                                if (retained === undefined) return undefined;
                                // Each sheet against its own projection. A delivery
                                // describes every sheet, so unlike the install path there
                                // is nothing to skip here — but the *pairing* is still the
                                // whole of it: reconciling one sheet's layers against
                                // another's projection would retire them on a coincidence
                                // of row numbers and heights between two sheets.
                                const layers = row_height_layers_for_delivery(
                                    retained.layers,
                                    next_row_height_projection[sheet_index] ?? {},
                                );
                                if (layers === retained.layers) return retained;
                                return layers.length === 0
                                    ? undefined
                                    : { ...retained, layers };
                            },
                        );
                    });
                    set_truncation_message(snapshot.truncationMessage);
                    set_csv_editable(snapshot.capabilities.csvEditable);
                    set_csv_edit_session_id(snapshot.capabilities.csvEditSessionId);
                    set_csv_editing_supported(
                        snapshot.capabilities.csvEditingSupported,
                    );

                    // Acknowledge the exact delivered identity before an optional
                    // corrective CAS write.
                    host_bridge.postMessage({
                        type: 'snapshotApplied',
                        identity: snapshot.identity,
                        disposition,
                    });
                    if (correction_required) persist_immediate();
                } else {
                    host_bridge.postMessage({
                        type: 'snapshotApplied',
                        identity: snapshot.identity,
                        disposition,
                    });
                }
            }

            if (
                msg.type === 'scrollToRow'
                && preview_mode_ref.current
                && Number.isFinite(msg.row)
            ) {
                queue_preview_scroll(msg.row);
            }

            if (msg.type === 'transformRefused') {
                if (
                    pending_transform_request_ids_ref.current[msg.sheetIndex]
                    !== msg.requestId
                ) {
                    return;
                }
                // A refusal means the host changed nothing, and this arm of
                // HostMessage carries nothing about the view for that reason: there
                // is no generation, state or row count here to adopt by accident.
                // All this path does is clear the in-flight UI, restore focus, and
                // warn.
                //
                // It cannot commit_live_edit() either, and now cannot be made to by
                // mistake: the fold in the install handler exists only because a
                // generation bump unmounts the grid that owns the overlay, and no
                // generation bump can arrive on this arm.
                //
                // The stamp the restore effect left in restore_request_blockers_ref
                // is deliberately not cleared, so the same doomed request is not
                // resent — with its global warning — on every same-basis refresh, and
                // every edit commit during an owned session produces one of those.
                // Only restore requests are stamped, so this latch cannot reach a
                // user-initiated one.
                //
                // A user-initiated request has no durable copy anywhere, and clearing
                // pending_transform_states_ref below therefore drops it outright.
                // That is the intended outcome, not an oversight to be fixed with a
                // queue: a sort or filter replayed seconds later — when a sibling's
                // session releases or a save finishes — would move rows under a user
                // who is mid-edit and has moved on, which is the one thing this whole
                // design exists to prevent, and it would amount to the deferred
                // "Resort/Refilter" action the design forbids. A refused user request
                // fails visibly (the warning below names the reason) and stays failed;
                // the user asks again if they still want it.
                const refusal_origin =
                    pending_transform_origins_ref.current[msg.sheetIndex];
                pending_transform_request_ids_ref.current[msg.sheetIndex] = undefined;
                pending_transform_states_ref.current[msg.sheetIndex] = undefined;
                pending_transform_origins_ref.current[msg.sheetIndex] = undefined;
                if (msg.terminal) {
                    // Retrying validation only fails again, so stop asking. This is
                    // what keeps a saved transform the sheet can no longer support
                    // from being re-requested — with its warning — once per snapshot.
                    // Leaving the flag false is conversely what lets the restore
                    // effect ask again after a refusal that clears on its own.
                    //
                    // Bookkeeping about the *request*, which is why it is not in
                    // `sheet_views`: nothing was installed, so there is no view here
                    // to record. The record still says what it always said.
                    restore_abandoned_ref.current[msg.sheetIndex] = true;
                }
                // Focus still has to come back. Our own unchanged generation is
                // precisely what the focus effect's
                // `grid_focus_restore.generation !== generation` check wants — and
                // reading it locally rather than from the message is now the only
                // option, which is the point.
                if (refusal_origin === 'grid') {
                    set_grid_focus_restore({
                        sheet_index: msg.sheetIndex,
                        generation: generation_ref.current,
                        document_epoch: document_epoch_ref.current,
                    });
                } else if (refusal_origin === 'toolbar') {
                    set_toolbar_focus_restore({
                        sheet_index: msg.sheetIndex,
                        document_epoch: document_epoch_ref.current,
                    });
                }
                set_pending_transforms((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = false;
                    return next;
                });
                set_pending_transform_labels((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = '';
                    return next;
                });
                // Nobody asked for a restore, so a refusal that clears on its own is
                // not news: the restore effect re-asks once the blocker moves, and in
                // the ordinary case — a sibling holding the edit session — every panel
                // showing the file would otherwise pop a warning about something its
                // user never did and can do nothing about. The latch above already
                // reduced this from once-per-commit to once-per-blocker-movement, but
                // unprompted at any rate is still unprompted.
                //
                // Terminal is different in kind and keeps its warning: the saved
                // transform really is being abandoned, nothing will re-ask, and the
                // view the user gets is not the one their file remembers. Saying so
                // is the honest thing even though they did not ask.
                //
                // `refusal_origin` deliberately read above, before the pending refs
                // were cleared.
                if (!(refusal_origin === 'restore' && !msg.terminal)) {
                    host_bridge.postMessage({
                        type: 'showWarning',
                        message: `Could not update the table view: ${msg.reason}`,
                    });
                }
                return;
            }

            if (msg.type === 'transformInstalled') {
                if (
                    pending_transform_request_ids_ref.current[msg.sheetIndex]
                    !== msg.requestId
                ) {
                    return;
                }
                const view = msg.view;
                const mapping_changed =
                    mapping_generations_ref.current[msg.sheetIndex]
                    !== msg.mappingGeneration;
                const next_mapping_generations = [
                    ...mapping_generations_ref.current,
                ];
                next_mapping_generations[msg.sheetIndex] = msg.mappingGeneration;
                mapping_generations_ref.current = next_mapping_generations;
                // Fold the open overlay into the store before the generation bump
                // below unmounts the grid that owns it — and only when that bump is
                // real. Arriving here is necessary but not sufficient: this is the
                // only message that *can* move the generation, so a refusal can no
                // longer reach the fold at all, but the host also answers a restore
                // or cancel whose rules it already holds with a no-op ack, and that
                // install leaves the generation exactly where it was. Nothing
                // remounts, so folding for it would commit an edit the user never
                // confirmed and put a half-typed value in the dirty store where
                // Escape can no longer take it back. That is reachable now that a
                // transform may be computing while the user types, so the comparison
                // stays — against the installed view's own basis, which is the
                // generation the record was computed on.
                //
                // Doable here rather than at dispatch time because GridShell is
                // still mounted and Glide's .gdg-clip-region overlay is still in
                // the DOM, so read_live_edit resolves; React batches set_generation
                // and flushes only after this handler returns. It works at all only
                // because the store's write is synchronous — the subscription plays
                // no part. Placed after the requestId guard so a stale or duplicated
                // ack doesn't fold for no reason. Where an authoritative install of
                // pending edits follows, it runs after the fold and still wins,
                // preserving "the grant/refresh owns the complete pending-edit
                // projection, including authoritative absence".
                if (view.basis.generation !== generation_ref.current) {
                    editing_ref.current?.commit_live_edit();
                }
                const origin = pending_transform_origins_ref.current[msg.sheetIndex];
                pending_transform_request_ids_ref.current[msg.sheetIndex] = undefined;
                pending_transform_states_ref.current[msg.sheetIndex] = undefined;
                pending_transform_origins_ref.current[msg.sheetIndex] = undefined;
                if (origin === 'grid') {
                    set_grid_focus_restore({
                        sheet_index: msg.sheetIndex,
                        generation: view.basis.generation,
                        document_epoch: document_epoch_ref.current,
                    });
                } else if (origin === 'toolbar') {
                    set_toolbar_focus_restore({
                        sheet_index: msg.sheetIndex,
                        document_epoch: document_epoch_ref.current,
                    });
                }
                set_pending_transforms((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = false;
                    return next;
                });
                set_pending_transform_labels((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = '';
                    return next;
                });
                set_generation(view.basis.generation);
                generation_ref.current = view.basis.generation;
                // Something installed, so whatever was refusing has cleared: the next
                // restore is free to ask again.
                restore_request_blockers_ref.current[msg.sheetIndex] = undefined;
                // The record arrives whole and is stored whole — the host built it
                // from its own state after the mutation, so there is nothing here to
                // recombine and no way to store the rules without the row count and
                // the basis they were computed with.
                //
                // Every *other* sheet's record is rebased onto the same generation,
                // because the generation is the core's and the indices are per sheet:
                // `handle_set_transform` writes `transform_indices` for its own sheet
                // and bumps one shared counter, so an install on this sheet moved no
                // row anywhere else. Left un-rebased, those records quote a generation
                // the core has passed, and the next refresh — which any capability
                // re-projection delivers — reads their basis as stale and replaces a
                // live permutation with the natural view. That is the same failure the
                // same-basis retention exists to prevent, one sheet over:
                // `transform_active` false and a natural row count over rows the
                // loader is still permuting. Only same-source records are rebased; a
                // different `sourceGeneration` is genuinely other rows, and the
                // snapshot handler's replacement is right for those.
                set_sheet_views((prev) => {
                    const next = prev.map((held, index) => (
                        index !== msg.sheetIndex
                        && held
                        && held.basis.sourceGeneration === view.basis.sourceGeneration
                            ? { ...held, basis: { ...held.basis, generation: view.basis.generation } }
                            : held
                    ));
                    next[msg.sheetIndex] = view;
                    return next;
                });
                // The height projection for the sheet that just installed, re-keyed by
                // the host into the display space of the permutation it installed. This
                // carrier is required rather than redundant: an install bumps the
                // generation and posts no snapshot at all — the transform persist runs
                // `update_file_state` → `update_session_state_material` →
                // `update_state_snapshot` with `deliver` defaulting false — so without it
                // the sheet would render heights keyed to the arrangement it has just
                // left, until some unrelated delivery came along.
                //
                // Every *other* sheet keeps the projection it has, which is the same
                // argument as the record rebase above and needs the same care to state:
                // the generation is the whole core's, but `handle_set_transform` writes
                // `transform_indices` for one sheet only, so no display row moved
                // anywhere else and the display keys those projections use still name the
                // rows they named. (What they can be is stale about *durable* heights a
                // sibling wrote — but so can `columnWidths`, for the same reason, and
                // layout state has no cross-panel fan-out to fix either. They correct
                // themselves on the next delivery.)
                set_row_height_projection((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = msg.rowHeights;
                    return next;
                });
                // The overlay, decided by the same `retained_row_height_overlay` the
                // snapshot path uses, because it is the same question. The only difference
                // between the two call sites is where the answer to "when did this sheet's
                // mapping last move?" comes from, and an install is the one event that can
                // answer it locally: `handle_set_transform` rewrites `transform_indices`
                // for `msg.sheetIndex` and bumps the shared counter, so this sheet's
                // mapping generation is now exactly the generation the ack carries, and no
                // other sheet's moved at all — for those, whatever relation held before
                // still holds, which the overlay's own `generation` expresses without needing
                // to know the value. Deriving it here rather than adding it to the message
                // keeps `transformInstalled` from carrying a per-sheet array it can compute
                // one entry of and would only ever read one entry of.
                //
                // The consequences of each verdict, since they are not symmetric. Another
                // sheet's overlay is retained *and rebased* — rebasing is load-bearing,
                // because the render site paints only an overlay whose generation is the
                // current one, so an un-rebased overlay silently vanishes on an install for
                // a sheet the user is not even looking at, while the host has accepted the
                // write it belonged to. This sheet's own overlay is voided when the install
                // moved its rows, because the new permutation invalidates its display keys
                // outright, and otherwise reconciled by value against the projection the
                // install carried.
                //
                // Which of those it is comes from `msg.mappingGeneration` and deliberately
                // not from `view.basis.generation`. They differ for an install that changes
                // the rules without producing a permutation — a filter added but left
                // disabled — where the core-wide generation moves and this sheet's mapping
                // does not. Reading the view generation here would void the overlay while
                // the host, asking the scoped question, *accepts* the old-generation write
                // it belonged to: the row snaps back and then silently returns when the
                // write is delivered. The two sides must ask one question, and this is the
                // same one `WorkbookSnapshot.mappingGenerations` answers on the delivery
                // path.
                //
                // Both verdicts are now pinned directly, which they were not before this
                // change: the void used to survive its own deletion because the render site
                // refused a stale-generation overlay anyway, so it was documented as jointly
                // held. Moving the decision into the shared helper made it a pure function
                // with unit tests either side of the comparison, and inverting it now fails
                // outright. The render-site generation gate is what became unfalsifiable in
                // the trade, and is labelled as such where it is read.
                set_row_height_overlay((previous) => mapped_row_height_overlays(
                    previous,
                    (overlay, sheet_index) => {
                        const retained = retained_row_height_overlay(
                            overlay,
                            view.basis.generation,
                            sheet_index === msg.sheetIndex
                                ? msg.mappingGeneration
                                : overlay.generation,
                        );
                        if (retained === undefined) return undefined;
                        // `msg.rowHeights` describes `msg.sheetIndex` and nothing else, so
                        // it can only answer an overlay belonging to that sheet.
                        // Reconciling another sheet's overlay against it would retire
                        // layers by a coincidence of row numbers and heights between two
                        // sheets.
                        if (sheet_index !== msg.sheetIndex) return retained;
                        const layers = row_height_layers_for_delivery(
                            retained.layers,
                            msg.rowHeights,
                        );
                        if (layers === retained.layers) return retained;
                        return layers.length === 0
                            ? undefined
                            : { ...retained, layers };
                    },
                ));
                // From the message's own `rules`, which is the rule set the host now
                // holds, not from the record: the record describes rows, and a view that
                // installed nothing has no rules on it to read. The message already
                // normalizes an entry-less set to `undefined`, so the durable copy takes
                // it verbatim. Reading a message is safe where reading a record is not —
                // nothing retains a message, so there is no copy here to go stale.
                const next_transforms = [
                    ...(state_ref.current.transforms ?? transforms),
                ];
                next_transforms[msg.sheetIndex] = msg.rules;
                state_ref.current = {
                    ...state_ref.current,
                    transforms: next_transforms,
                };
                set_transforms(next_transforms);
                // Only an advanced mapping changes the population sampled by
                // auto-fit. A rules-only no-op install moves the core generation but
                // leaves the measured rows intact.
                if (mapping_changed) {
                    // A restore was already durably owed when an all-sheets fit was
                    // requested, so keep that fit queued for the installed rows when
                    // there are any to sample. A transform initiated afterward
                    // supersedes the older request.
                    if (origin !== 'restore' || view.rowCount === 0) {
                        cancel_pending_auto_fit_for_sheet(msg.sheetIndex);
                    }
                    const next_active = [...auto_fit_active_ref.current];
                    const next_snapshot = [...auto_fit_snapshot_ref.current];
                    next_active[msg.sheetIndex] = false;
                    next_snapshot[msg.sheetIndex] = undefined;
                    auto_fit_active_ref.current = next_active;
                    auto_fit_snapshot_ref.current = next_snapshot;
                    set_auto_fit_active(next_active);
                    set_auto_fit_snapshot(next_snapshot);
                }
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [
        active_sheet_index,
        apply_save_lifecycle,
        cancel_pending_auto_fit_for_sheet,
        clear_pending_preview_scroll,
        persist_immediate,
        queue_preview_scroll,
        reset_save_projection,
        update_pending_auto_fit_sheets,
    ]);

    useEffect(() => {
        if (!grid_focus_restore) return;
        if (
            grid_focus_restore.sheet_index !== active_sheet_index
            || grid_focus_restore.document_epoch !== document_epoch_ref.current
        ) {
            set_grid_focus_restore(null);
            return;
        }
        // Native host-message updates are not guaranteed to batch. If the focus
        // token renders before the generation update, retain it for that next commit.
        if (grid_focus_restore.generation !== generation) return;

        let timer: number | undefined;
        let attempt = 0;
        const restore = () => {
            if (
                grid_focus_restore.document_epoch !== document_epoch_ref.current
                || grid_focus_restore.sheet_index !== active_sheet_index
            ) {
                set_grid_focus_restore((current) => (
                    current === grid_focus_restore ? null : current
                ));
                return;
            }
            if (!document.hasFocus()) {
                set_grid_focus_restore((current) => (
                    current === grid_focus_restore ? null : current
                ));
                return;
            }
            const handle = grid_focus_ref.current;
            if (
                handle?.generation === grid_focus_restore.generation
                && handle.focus()
            ) {
                set_grid_focus_restore((current) => (
                    current === grid_focus_restore ? null : current
                ));
                return;
            }
            attempt += 1;
            if (attempt >= GRID_FOCUS_RESTORE_MAX_ATTEMPTS) {
                set_grid_focus_restore((current) => (
                    current === grid_focus_restore ? null : current
                ));
                return;
            }
            timer = window.setTimeout(restore, GRID_FOCUS_RESTORE_RETRY_MS);
        };
        // Let Glide complete its post-mount canvas replacement before focusing;
        // an immediately focused bootstrap canvas is removed on the next frame.
        timer = window.setTimeout(
            restore,
            GRID_FOCUS_RESTORE_RETRY_MS * 2,
        );
        return () => {
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [active_sheet_index, generation, grid_focus_restore]);

    useLayoutEffect(() => {
        if (!toolbar_focus_restore) return;
        if (
            toolbar_focus_restore.sheet_index !== active_sheet_index
            || toolbar_focus_restore.document_epoch !== document_epoch_ref.current
        ) {
            set_toolbar_focus_restore(null);
            return;
        }

        // Menu activation restores a surviving chip on a zero-delay timer. Wait one
        // turn before deciding that acknowledgement removed the initiating control;
        // this preserves that chip while still catching Remove/Clear/Cancel teardown.
        const timer = window.setTimeout(() => {
            const active = document.activeElement;
            const focus_survived = active instanceof HTMLElement
                && active !== document.body
                && active !== document.documentElement
                && active.isConnected;
            if (!focus_survived && document.hasFocus()) {
                toolbar_focus_ref.current?.focus();
            }
            set_toolbar_focus_restore((current) => (
                current === toolbar_focus_restore ? null : current
            ));
        }, 0);
        return () => window.clearTimeout(timer);
    }, [active_sheet_index, toolbar_focus_restore]);

    useEffect(() => {
        host_bridge.postMessage({ type: 'ready' });
        return () => {
            release_edit_session();
        };
    }, []);

    // Recompute persisted transforms against each freshly loaded source. The
    // host intentionally drops permutations on reload because matching schema
    // does not imply matching values.
    //
    // Not gated on edit_mode: the host admits a transform from the panel holding
    // the session, so re-requesting the stored transform during an owned session
    // is legitimate — and skipping it would leave the user's own saved sort
    // silently uninstalled for the rest of the session. Preview keeps its gate
    // (natural source order is a trust boundary there) and so does a pending
    // Excel header change, which is about to reshape the rows itself.
    //
    // A save in flight is a gate rather than a plain skip: the host refuses a
    // transform during a save, and a refusal changes none of this effect's other
    // deps, so without the boolean in the dep list a refresh mid-save would leave
    // the stored transform uninstalled forever. Depending on the boolean and not
    // on `editing_status` is deliberate — the grid reports editing status on every
    // commit, so the object would re-run this on every keystroke.
    const save_in_flight = save_lifecycle.state === 'active'
        || save_operation !== undefined
        || editing_status?.save_in_flight === true;
    // Counts observed movements of the conditions under which the host refuses a
    // transform and which this webview can actually see: another panel owning the
    // edit session projects `csvEditable: false` here and true again once it
    // releases, and a save of our own is reported through editing status. A count
    // rather than the values themselves, because what matters is that a blocker
    // *moved* — a save goes in and back out of flight, leaving the boolean where it
    // started, and the restore has to be retried on the way out. Stamped on each
    // restore request and compared on the next run: see
    // `restore_request_blockers_ref`.
    const [restore_blocker_epoch, set_restore_blocker_epoch] = useState(0);
    useEffect(() => {
        set_restore_blocker_epoch((n) => n + 1);
    }, [csv_editable, save_in_flight]);
    useEffect(() => {
        if (!meta || preview_mode || pending_excel_header !== null) return;
        if (save_in_flight) return;
        const sheet = meta.sheets[active_sheet_index];
        if (!sheet) return;
        if (
            restore_abandoned_ref.current[active_sheet_index]
            || pending_transform_request_ids_ref.current[active_sheet_index]
        ) {
            return;
        }
        // A restore already asked under exactly these conditions and nothing
        // installed, so asking again would only repeat the refusal — and its global
        // warning — once per edit commit, because every commit during an owned
        // session redelivers a snapshot and so bumps `source_epoch`. The stamp is
        // dropped when a transform does install, when the row basis changes, and
        // whenever a blocking condition moves, so the restore still lands once the
        // blocker clears.
        if (
            restore_request_blockers_ref.current[active_sheet_index]
            === restore_blocker_epoch
        ) {
            return;
        }
        const state = sanitize_transform_state(
            state_ref.current.transforms?.[active_sheet_index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
            sheet.sourceRowCount,
        );
        const installed = sheet_views[active_sheet_index];
        // One comparison, both directions, one request. An install branch with no
        // else was how a sibling's cleared sort came to leave the rows permuted
        // under a toolbar showing no rules: only the host can un-permute the loader,
        // so a reconciliation that can only ever add rules has no way back. What
        // reconciling means is decided by the data below rather than by which branch
        // the reader happens to be in.
        //
        // Nothing to reconcile when the durable rules already describe the view we
        // hold. Every edit commit during an owned session redelivers a same-basis
        // refresh and so bumps `source_epoch`, so without this the effect would fire
        // a restore request per keystroke-commit. The host short-circuits an equal
        // restore intent at the same generation, but that no-op ack is still a
        // `transformInstalled`, and the install handler discards
        // `auto_fit_active`/`auto_fit_snapshot` — correctly, since a real transform
        // changes the population auto-fit sampled — so the Auto-fit toggle would
        // switch itself off on every commit. Skipping the pointless round-trip
        // removes that and any other side effect a no-op ack could carry.
        //
        // Compared against the rules of a *permutation* only. A non-permuted record has
        // none, and that is the point rather than a gap to fill from durable state: the
        // question here is whether the durable rules already describe the view we hold,
        // and a view holding no permutation is described by no rules at all. The
        // inactive-both case that used to reach this comparison through a retained
        // record's stale copy is rejected by the shared predicate from the same two
        // facts and without the copy. That also excludes differing definitions nobody
        // is applying, such as a disabled filter over a natural view.
        if (!transform_reconciliation_required(state, installed)) return;
        // Sending the sanitized durable state — rather than the active half of it, or
        // a bare EMPTY_TRANSFORM — is what carries both directions. When it is active
        // this installs it. When it is not, it is the rule-free view, and sending it
        // as-is keeps disabled filter definitions the user may re-enable; only when
        // there is nothing durable left at all is the empty state sent, stamped with
        // this sheet's schema the way handle_transform_change does.
        //
        // Deliberately not gated on edit mode. `admit_transform_for_phase` refuses a
        // sibling's transform while we own the session, so the durable rules cannot
        // go inactive from a sibling mid-session; a gate here would instead create a
        // state that never reconciles, since leaving edit mode moves no dep of this
        // effect.
        restore_request_blockers_ref.current[active_sheet_index] =
            restore_blocker_epoch;
        request_transform(
            active_sheet_index,
            state ?? {
                ...EMPTY_TRANSFORM,
                schema: transform_schema_for_sheet(sheet),
            },
            'restore',
            'restore',
        );
    }, [
        source_epoch,
        meta,
        preview_mode,
        pending_excel_header,
        active_sheet_index,
        sheet_views,
        request_transform,
        save_in_flight,
        restore_blocker_epoch,
    ]);

    const handle_sheet_select = useCallback(
        (sheet_index: number) => {
            // A Save/Discard/Cancel dialog is a question about *one* worksheet, and
            // the answer is applied against `editing_ref.current` — which follows
            // the active sheet. Switching tabs while it is open therefore pointed
            // the answer at the wrong worksheet: the store for the new sheet has no
            // session, so `request_save()` and `has_uncommitted_changes()` both
            // returned false and a "Save" choice took the exit path instead,
            // releasing the session without ever posting the save. The user asked
            // to save and the edits were dropped.
            //
            // Held rather than redirected: the dialog is already on screen naming
            // this worksheet's file, so answering it is a two-second interaction and
            // silently retargeting it would be its own surprise. Cancel returns
            // control immediately.
            if (pending_save_dialog_ref.current) return;
            // The grid is keyed by the active sheet, so this unmounts the one
            // holding any open overlay editor — and Glide portals that editor
            // outside the tree, so its cleanup releases the captured row without
            // committing the text. Fold it first, as the transform and refresh
            // remounts do; the store lives above the grid and keeps it.
            editing_ref.current?.commit_live_edit();
            set_filter_editor(null);
            set_grid_focus_restore(null);
            set_toolbar_focus_restore(null);
            set_active_sheet_index(sheet_index);
            state_ref.current = {
                ...state_ref.current,
                activeSheetIndex: sheet_index,
            };
            persist_immediate();
        },
        [persist_immediate]
    );

    const handle_sheet_context_menu = useCallback((
        sheet_index: number,
        x: number,
        y: number,
    ) => {
        set_sheet_context_menu({ sheet_index, x, y });
    }, []);

    const handle_strip_context_menu = useCallback((x: number, y: number) => {
        set_sheet_context_menu({ sheet_index: null, x, y });
    }, []);

    const run_sheet_action = useCallback((
        sheet_index: number,
        action: SheetAction,
    ) => {
        set_sheet_context_menu(null);
        const handle = grid_actions_ref.current;
        // Active sheet with a matching mounted handle runs immediately.
        if (sheet_index === active_sheet_index && handle?.sheet_index === sheet_index) {
            handle[action]();
            return;
        }
        // Otherwise defer: switch to the target sheet and run once its grid mounts.
        set_pending_sheet_action({ sheet_index, action });
        if (sheet_index !== active_sheet_index) {
            handle_sheet_select(sheet_index);
        }
    }, [active_sheet_index, handle_sheet_select]);

    // Release a deferred sheet action once the active sheet and the mounted grid
    // handle both match the target. Re-checked after any keyed grid remount.
    useEffect(() => {
        if (!pending_sheet_action) return;
        const action = pending_sheet_action_to_run(
            pending_sheet_action,
            active_sheet_index,
            grid_actions_ref.current?.sheet_index,
        );
        if (!action) return;
        // A newly mounted sheet may still owe a persisted-transform request: the
        // restore effect above runs first each commit and synchronously records
        // the pending request id when it dispatches. Waiting on that ref keeps
        // "Copy sheet" from serializing untransformed rows and "Select all" from
        // selecting a grid that the transform acknowledgement remounts. When the
        // request is acknowledged the generation bump re-runs this effect.
        if (pending_transform_request_ids_ref.current[active_sheet_index]) return;
        grid_actions_ref.current?.[action]();
        set_pending_sheet_action((current) =>
            current === pending_sheet_action ? null : current);
    }, [active_sheet_index, generation, load_epoch, pending_sheet_action]);

    // Copy / Select All arriving from a host menu that owns the keyboard
    // shortcut (the desktop app's native Edit menu). Whatever has focus decides:
    // the CSV cell editor's text field, otherwise the grid.
    const run_edit_command = useCallback((command: EditCommand) => {
        const active = document.activeElement;
        if (edit_command_target(active) === 'text') {
            const field = active as HTMLInputElement | HTMLTextAreaElement;
            if (command === 'selectAll') {
                field.select?.();
                return;
            }
            const text = typeof field.value === 'string'
                ? text_field_selection(field)
                : '';
            if (text) {
                void navigator.clipboard.writeText(text).catch((error) => {
                    console.error('Failed to write to clipboard', error);
                });
            }
            return;
        }
        const handle = grid_actions_ref.current;
        if (command === 'selectAll') handle?.select_all();
        else handle?.copy_selection();
    }, []);

    /**
     * The only writer, so the live array and the persisted copy cannot drift.
     *
     * Persisted per file: reloading the same file after an external edit keeps the
     * choice, and opening a different file in this panel gets that file's own rather
     * than inheriting this one's by sheet index (#154).
     */
    const update_show_formatting = useCallback(
        (updater: (prev: readonly (boolean | undefined)[]) => (boolean | undefined)[]) => {
            set_show_formatting_by_sheet((prev) => {
                const next = updater(prev);
                state_ref.current = { ...state_ref.current, showFormatting: [...next] };
                persist_immediate();
                return next;
            });
        },
        [persist_immediate],
    );

    const handle_toggle_formatting = useCallback(() => {
        update_show_formatting((prev) => {
            const next = [...prev];
            next[active_sheet_index] = !(next[active_sheet_index] ?? true);
            return next;
        });
    }, [active_sheet_index, update_show_formatting]);

    /** Put every sheet into the same formatting state, for the chevron menu. */
    const set_formatting_all_sheets = useCallback((formatted: boolean) => {
        update_show_formatting(
            () => new Array(meta?.sheets.length ?? 0).fill(formatted),
        );
    }, [meta, update_show_formatting]);

    const request_excel_header = useCallback((
        enabled: boolean,
        unhide_all = false,
        header_row?: number,
        // The host keys the request by sheet, so an inactive sheet is addressable
        // without switching to it — which is what lets "all sheets" run as a queue
        // rather than as a tour of the workbook.
        target_sheet_index = active_sheet_index,
    ) => {
        const sheet = meta?.sheets[target_sheet_index];
        const header = sheet?.excelFirstRowHeader;
        // Every header affordance funnels through here: the primary toggle, row
        // promotion, Unhide all for a promoted header, and the all-sheets queue.
        // Edit mode can commit an open cell and refresh the worksheet before this
        // command reaches the host, invalidating the generation it was posted with.
        // Keep this guard at the shared command boundary as well as disabling each
        // visible affordance, so a stale callback or a queue cannot bypass it.
        if (
            !sheet
            || !header
            || edit_mode_ref.current
            || pending_excel_header_ref.current
        ) return;
        const request_id = `header:${excel_header_request_prefix_ref.current}:${
            ++excel_header_request_seq_ref.current
        }`;
        pending_excel_header_ref.current = request_id;
        pending_excel_header_unhide_ref.current = unhide_all;
        pending_excel_header_promote_ref.current = header_row !== undefined;
        set_pending_excel_header(request_id);
        set_excel_header_status(
            unhide_all
                ? 'Restoring rows…'
                : header_row !== undefined
                ? 'Making row header…'
                : 'Updating column names…',
        );
        host_bridge.postMessage({
            type: 'setExcelFirstRowHeader',
            sheetIndex: target_sheet_index,
            sheetName: sheet.name,
            enabled,
            ...(unhide_all ? { unhideAll: true } : {}),
            ...(header_row !== undefined ? { headerRow: header_row } : {}),
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
        });
    }, [active_sheet_index, meta]);

    const handle_toggle_excel_header = useCallback(() => {
        const header = meta?.sheets[active_sheet_index]?.excelFirstRowHeader;
        if (!header) return;
        request_excel_header(!(header.mode === 'on' || header.active));
    }, [active_sheet_index, meta, request_excel_header]);

    /**
     * Sheets still owed a header-row change, and the state to put them in.
     *
     * The host takes one of these at a time — `request_excel_header` refuses while a
     * request is in flight — so "all sheets" is a queue drained by the effect below
     * rather than a burst. Sheets already in the target state never enter it.
     */
    const [excel_header_queue, set_excel_header_queue] = useState<{
        enabled: boolean;
        sheets: readonly number[];
    } | null>(null);

    useEffect(() => {
        if (!excel_header_queue || pending_excel_header !== null) return;
        const [next_sheet, ...rest] = excel_header_queue.sheets;
        if (next_sheet === undefined) return set_excel_header_queue(null);
        set_excel_header_queue({ ...excel_header_queue, sheets: rest });
        request_excel_header(excel_header_queue.enabled, false, undefined, next_sheet);
    }, [excel_header_queue, pending_excel_header, request_excel_header]);

    /** Queue every sheet that is not already in `enabled`, for the chevron menu. */
    const set_excel_header_all_sheets = useCallback((enabled: boolean) => {
        if (edit_mode_ref.current) return;
        const sheets = (meta?.sheets ?? [])
            .map((sheet, index) => ({ sheet, index }))
            .filter(({ sheet }) => {
                const header = sheet.excelFirstRowHeader;
                if (!header) return false;
                return (header.mode === 'on' || header.active) !== enabled;
            })
            .map(({ index }) => index);
        if (sheets.length > 0) set_excel_header_queue({ enabled, sheets });
    }, [meta]);

    const handle_promote_row_to_header = useCallback((display_row: number) => {
        request_excel_header(true, false, display_row);
    }, [request_excel_header]);

    const handle_toggle_edit_mode = useCallback(() => {
        const entering = !edit_mode;
        if (entering) {
            if (edit_session_pending) return;
            // Only work in flight, and only because the host refuses it: warning
            // locally saves a round-trip whose answer is already known. An
            // *installed* sort, filter, or hidden-row rule is no longer a reason
            // to warn — editing under one is supported and moves no rows.
            if (pending_transforms[active_sheet_index]) {
                host_bridge.postMessage({
                    type: 'showWarning',
                    message: 'Wait for sorting and filtering to finish before entering edit mode.',
                });
                return;
            }
            set_edit_session_pending(true);
            const request_id = [
                'edit',
                edit_request_prefix_ref.current,
                ++edit_request_seq_ref.current,
            ].join(':');
            pending_edit_request_ref.current = request_id;
            const requested_sheet = meta?.sheets[active_sheet_index];
            host_bridge.postMessage({
                type: 'requestEditSession',
                requestId: request_id,
                // The sheet whose Edit button requested the workbook session. It
                // becomes the initial renderer pointer for this one shared grant.
                sheetIndex: active_sheet_index,
                sheetName: requested_sheet?.name,
                worksheetId: requested_sheet?.worksheetId,
            });
            return;
        }
        // Fold the active overlay before testing the registry: the session is
        // workbook-wide and App owns the complete dirty-set decision.
        editing_ref.current?.commit_live_edit();
        if (edit_session_registry_ref.current!.has_dirty_entries()) {
            if (!csv_edit_session_id || pending_save_dialog_ref.current) return;
            const request = {
                requestId: [
                    'dialog',
                    edit_request_prefix_ref.current,
                    ++dialog_request_seq_ref.current,
                ].join(':'),
                editSessionId: csv_edit_session_id,
            };
            pending_save_dialog_ref.current = request;
            host_bridge.postMessage({
                type: 'showSaveDialog',
                requestId: request.requestId,
                editSessionId: request.editSessionId,
            });
            return;
        }
        leave_edit_mode();
    }, [
        edit_mode,
        leave_edit_mode,
        pending_transforms,
        edit_session_pending,
        active_sheet_index,
        csv_edit_session_id,
        meta,
    ]);

    /**
     * The one place that decides whether this webview will ask the host for a
     * transform at all. Its own function because four call sites need the same
     * answer and drifted once already: Cancel checked only the save, and a cancel is
     * itself a transform request.
     *
     * Edit mode is deliberately not here: the host admits a transform from the panel
     * that owns the session. A save in flight is, because it has already validated
     * every edit's base against the natural source (see `save_blocks_transform` in
     * viewer-controller.ts). `edit_session_pending` is a claim mid-flight, which the
     * host refuses in its `claiming` phase — so a request sent under it is one the
     * host would refuse anyway, and for Cancel that refusal costs the requestId of
     * the very request being cancelled. A pending Excel header promotion is
     * reshaping the rows underneath. Preview mode offers no transform affordances at
     * all, so the term is inert there, and it is kept so the sets are honestly
     * identical rather than nearly so.
     */
    const transform_request_blocked = useCallback((): boolean => (
        save_in_flight_ref.current
        || edit_session_pending
        || preview_mode
        || pending_excel_header_ref.current !== null
    ), [edit_session_pending, preview_mode]);

    const handle_transform_change = useCallback(
        (next_state: SheetTransformState, origin: TransformOrigin): boolean => {
            if (transform_request_blocked()) return false;
            const schema = meta?.sheets[active_sheet_index]
                ? transform_schema_for_sheet(meta.sheets[active_sheet_index])
                : undefined;
            const active_sheet = meta?.sheets[active_sheet_index];
            const column_count = active_sheet?.columnCount ?? 0;
            const source_row_count = active_sheet?.sourceRowCount ?? 0;
            const sanitized = sanitize_transform_state(
                { ...next_state, schema },
                column_count,
                schema,
                source_row_count,
            ) ?? {
                sort: [],
                filters: [],
                schema,
            };
            const current = sanitize_transform_state(
                pending_transform_states_ref.current[active_sheet_index]
                    ?? state_ref.current.transforms?.[active_sheet_index],
                column_count,
                schema,
                source_row_count,
            );
            if (transforms_semantically_equal(current, sanitized)) return false;
            request_transform(active_sheet_index, sanitized, 'user', origin);
            return true;
        },
        [
            active_sheet_index,
            meta,
            request_transform,
            transform_request_blocked,
        ],
    );

    const handle_hide_rows = useCallback((display_rows: DisplayRowInterval[]) => {
        if (
            transform_request_blocked()
            || pending_transforms[active_sheet_index]
        ) return;
        const request_id = [
            'transform',
            transform_request_prefix_ref.current,
            active_sheet_index,
            ++transform_request_seq_ref.current,
        ].join(':');
        pending_transform_request_ids_ref.current[active_sheet_index] = request_id;
        pending_transform_states_ref.current[active_sheet_index] = undefined;
        pending_transform_origins_ref.current[active_sheet_index] = 'grid';
        set_pending_transforms((prev) => {
            const next = [...prev];
            next[active_sheet_index] = true;
            return next;
        });
        set_pending_transform_labels((prev) => {
            const next = [...prev];
            next[active_sheet_index] = 'Hiding rows…';
            return next;
        });
        host_bridge.postMessage({
            type: 'hideRows',
            sheetIndex: active_sheet_index,
            displayRows: display_rows,
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
        });
    }, [
        active_sheet_index,
        pending_transforms,
        transform_request_blocked,
    ]);

    const handle_unhide_all_rows = useCallback(() => {
        const header = meta?.sheets[active_sheet_index]?.excelFirstRowHeader;
        if (header?.mode === 'on' && header.sourceRow !== 0) {
            request_excel_header(false, true);
            return;
        }
        const current = state_ref.current.transforms?.[active_sheet_index]
            ?? transforms[active_sheet_index]
            ?? EMPTY_TRANSFORM;
        const { hiddenRows: _hidden_rows, ...next } = current;
        handle_transform_change(next, 'toolbar');
    }, [
        active_sheet_index,
        handle_transform_change,
        meta,
        request_excel_header,
        transforms,
    ]);

    const handle_grid_transform_change = useCallback(
        (next_state: SheetTransformState) => {
            handle_transform_change(next_state, 'grid');
        },
        [handle_transform_change],
    );
    const handle_toolbar_transform_change = useCallback(
        (next_state: SheetTransformState) => {
            handle_transform_change(next_state, 'toolbar');
        },
        [handle_transform_change],
    );

    const open_filter_editor = useCallback((
        column_index: number,
        anchor: { left: number; top: number },
        restore_focus: () => void,
        origin: Exclude<TransformOrigin, 'restore'>,
    ) => {
        if (filter_restore_timer_ref.current !== undefined) {
            window.clearTimeout(filter_restore_timer_ref.current);
            filter_restore_timer_ref.current = undefined;
        }
        if (
            transform_request_blocked()
            || pending_transforms[active_sheet_index]
        ) return;
        set_filter_editor({ column_index, anchor, restore_focus, origin });
    }, [
        active_sheet_index,
        pending_transforms,
        transform_request_blocked,
    ]);

    const open_grid_filter_editor = useCallback((
        column_index: number,
        anchor: { left: number; top: number },
        restore_focus: () => void,
    ) => {
        open_filter_editor(column_index, anchor, restore_focus, 'grid');
    }, [open_filter_editor]);

    useEffect(() => {
        if (!filter_editor) return;
        const sheet_index = active_sheet_index;
        const column_index = filter_editor.column_index;
        const request_generation = generation_ref.current;
        const request_source_generation = source_generation_ref.current;
        const key = `${request_source_generation}:${sheet_index}:${column_index}`;
        const cached = histogram_cache_ref.current.get(key);
        if (cached) {
            set_filter_histogram({
                key,
                value: { status: 'ready', ...cached },
            });
            return;
        }

        const request_id = [
            'histogram',
            histogram_request_prefix_ref.current,
            ++histogram_request_seq_ref.current,
        ].join(':');
        const pending = {
            requestId: request_id,
            key,
            sheetIndex: sheet_index,
            columnIndex: column_index,
            generation: request_generation,
            sourceGeneration: request_source_generation,
        };
        pending_histogram_ref.current = pending;
        set_filter_histogram({ key, value: { status: 'loading' } });
        host_bridge.postMessage({
            type: 'requestFilterHistogram',
            sheetIndex: sheet_index,
            columnIndex: column_index,
            requestId: request_id,
            generation: request_generation,
            sourceGeneration: request_source_generation,
        });
        return () => {
            if (pending_histogram_ref.current !== pending) return;
            pending_histogram_ref.current = null;
            host_bridge.postMessage({
                type: 'cancelFilterHistogram',
                requestId: request_id,
            });
        };
    }, [active_sheet_index, filter_editor, source_epoch]);

    const close_filter_editor = useCallback((restore_focus = true) => {
        const restore = filter_editor?.restore_focus;
        set_filter_editor(null);
        if (filter_restore_timer_ref.current !== undefined) {
            window.clearTimeout(filter_restore_timer_ref.current);
        }
        if (restore_focus) {
            filter_restore_timer_ref.current = window.setTimeout(() => {
                filter_restore_timer_ref.current = undefined;
                restore?.();
            }, 0);
        } else {
            filter_restore_timer_ref.current = undefined;
        }
    }, [filter_editor]);

    const apply_filter_editor = useCallback((entry: FilterEntry) => {
        if (!filter_editor) return;
        const current = transforms[active_sheet_index] ?? EMPTY_TRANSFORM;
        const requested = handle_transform_change({
            ...current,
            filters: upsert_filter(current.filters, entry),
        }, filter_editor.origin);
        close_filter_editor(!requested || filter_editor.origin === 'toolbar');
    }, [
        active_sheet_index,
        close_filter_editor,
        filter_editor,
        handle_transform_change,
        transforms,
    ]);

    const remove_filter_editor = useCallback(() => {
        if (!filter_editor) return;
        const current = transforms[active_sheet_index] ?? EMPTY_TRANSFORM;
        // Remove by column, matching how the popover determines "existing".
        const requested = handle_transform_change({
            ...current,
            filters: current.filters.filter(
                (entry) => entry.colIndex !== filter_editor.column_index,
            ),
        }, filter_editor.origin);
        close_filter_editor(!requested || filter_editor.origin === 'toolbar');
    }, [
        active_sheet_index,
        close_filter_editor,
        filter_editor,
        handle_transform_change,
        transforms,
    ]);

    const handle_cancel_transform = useCallback(() => {
        // A cancel the host would refuse must not displace the request it is
        // cancelling: request_transform overwrites the pending requestId, so the
        // original in-flight response would stop matching and the webview would sit
        // on a stale generation. That is why a cancel asks the same question every
        // other transform request asks — see `transform_request_blocked`.
        if (transform_request_blocked()) return;
        const previous = transform_rollback_baseline(
            sheet_views[active_sheet_index],
            state_ref.current.transforms?.[active_sheet_index],
            meta?.sheets[active_sheet_index]
                ? transform_schema_for_sheet(meta.sheets[active_sheet_index])
                : undefined,
        );
        const pending_state = pending_transform_states_ref.current[active_sheet_index];
        const current = pending_state
            ?? state_ref.current.transforms?.[active_sheet_index];
        if (
            pending_state !== undefined
            && transforms_semantically_equal(current, previous)
        ) return;
        request_transform(active_sheet_index, previous, 'cancel');
    }, [
        active_sheet_index,
        meta,
        request_transform,
        sheet_views,
        transform_request_blocked,
    ]);

    const request_save_or_remain_dirty = useCallback(() => {
        const editing = editing_ref.current;
        if (!editing) return false;
        // request_save() has side effects, so it is evaluated first. If workbook
        // preflight blocks, the active sheet may be clean while a sibling store is
        // still dirty; keep the session open from the registry-wide truth.
        return editing.request_save()
            || edit_session_registry_ref.current!.has_dirty_entries();
    }, []);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;
            if (msg.type === 'fontChanged') {
                apply_font_family(msg.fontFamily);
                apply_font_size(msg.fontSize);
            }
            if (msg.type === 'selectSheet') {
                handle_sheet_select(msg.sheetIndex);
            }
            if (msg.type === 'editCommand') {
                run_edit_command(msg.command);
            }
            if (msg.type === 'editSessionResult') {
                if (pending_edit_request_ref.current !== msg.requestId) return;
                pending_edit_request_ref.current = null;
                set_edit_session_pending(false);
                if (msg.granted && msg.editSessionId) {
                    set_csv_edit_session_id(msg.editSessionId);
                    // Taken from the grant rather than from the active tab: the two
                    // can differ if the user switched sheets while the request was
                    // in flight, and the session belongs to the sheet the host
                    // granted.
                    // A grant that names no sheet is a single-sheet source's, whose
                    // only sheet is 0.
                    //
                    // The registry is deliberately left alone here. The session
                    // is workbook-scoped, so a grant on another worksheet is the
                    // same session continuing there: the other sheets' stores
                    // hold that session's own unsaved edits and must survive.
                    // The grant carries only the granted sheet's slot, and the
                    // install below replaces exactly that store. Cross-document
                    // and reorder staleness are the snapshot handler's to fix —
                    // every grant answers a request sent against the workbook
                    // the snapshot already reconciled the registry to.
                    edit_session_sheet_index_ref.current = msg.sheetIndex ?? 0;
                    // The grant owns the complete pending-edit projection, including
                    // authoritative absence. Always cross a hydration boundary so a
                    // previously mounted editing hook cannot retain another session.
                    //
                    // The boundary is `install_edit_session` plus the `adopt_session`
                    // layout effect, not a remount. Since #104 the dirty map lives in
                    // App's own store; `use_editing` reads it through
                    // useSyncExternalStore rather than a useState initializer, and
                    // `install` force-notifies, so a changed map — including an empty
                    // one — installs into the mounted grid. Bumping load_epoch here
                    // would also reset column visibility, and entering edit mode is
                    // not a data reload.
                    install_edit_session(msg.pendingEdits, msg.editSessionId);
                    set_edit_mode(true);
                } else if (csv_edit_session_id_ref.current === undefined) {
                    pending_exit_ref.current = false;
                    set_csv_edit_session_id(undefined);
                    set_edit_mode(false);
                }
            } else if (msg.type === 'editSessionRevoked') {
                apply_save_lifecycle(msg.lifecycle);
            } else if (msg.type === 'saveDialogResult') {
                const pending_dialog = pending_save_dialog_ref.current;
                if (
                    !pending_dialog
                    || pending_dialog.requestId !== msg.requestId
                    || pending_dialog.editSessionId !== msg.editSessionId
                ) return;
                pending_save_dialog_ref.current = null;
                if (msg.choice === 'save') {
                    if (request_save_or_remain_dirty()) {
                        pending_exit_ref.current = true;
                    } else {
                        leave_edit_mode();
                    }
                } else if (msg.choice === 'discard') {
                    editing_ref.current?.clear_dirty();
                    discard_edit_session();
                }
                // 'cancel' → stay in edit mode, keep edits.
            } else if (msg.type === 'saveResult') {
                const operation = save_projection_ref.current.operation;
                const transition = apply_save_lifecycle(msg.lifecycle);
                // Lifecycle revision is the ordering authority for the whole result,
                // not just its projection. A stale terminal must not clear or replace
                // the verdict installed by a later accepted result.
                if (!transition.changed) return;
                const matching = !operation
                    || csv_save_operations_equal(operation, msg.lifecycle.operation);
                // Every accepted save result supersedes the previous one, including a
                // success and including a rejection that named different keys. Clearing
                // here, before the adoption block below re-records one, is what makes a
                // *successful* save drop the banner: adoption only ever sets, so
                // without this a rejection would survive until the session ended.
                clear_save_verdict();
                if (matching) {
                    pending_exit_ref.current = false;
                }
                // Adopt the host's named keys only for our own session: a rejection
                // for someone else's session names keys our store does not hold, and
                // a banner over them would offer a discard that does nothing. Ride
                // in on the lifecycle rather than a separate message so the map has
                // already been restored above (see CsvSaveRejection in types.ts).
                if (
                    msg.rejection
                    && msg.lifecycle.operation.editSessionId
                        === csv_edit_session_id_ref.current
                ) {
                    const submitted_worksheet = msg.lifecycle.operation.worksheets[
                        msg.rejection.worksheetOperationIndex
                    ];
                    if (!submitted_worksheet) return;
                    const submitted = submitted_worksheet.dirtyEdits;
                    set_save_rejection({
                        reason: msg.rejection.reason,
                        keys: [...msg.rejection.keys],
                        session_id: csv_edit_session_id_ref.current,
                        sheet_index: submitted_worksheet.sheetIndex,
                        sheet_name: submitted_worksheet.sheetName,
                        worksheet_id: submitted_worksheet.worksheetId,
                        // Snapshot what the host actually judged, from the operation
                        // it judged it over rather than from the live map, which may
                        // already have moved on. `live_rejected_keys` compares against
                        // this so a key that came back with a different value or a
                        // re-read base is understood as a new, unjudged edit.
                        entries: Object.fromEntries(
                            msg.rejection.keys.map((key) => [
                                key,
                                {
                                    value: submitted[key]?.value ?? '',
                                    base: submitted[key]?.base ?? '',
                                },
                            ]),
                        ),
                    });
                }
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [
        apply_save_lifecycle,
        discard_edit_session,
        install_edit_session,
        handle_sheet_select,
        leave_edit_mode,
        persist_immediate,
        request_save_or_remain_dirty,
        run_edit_command,
    ]);

    // If editing becomes unavailable (e.g. a reload disables CSV editing), leave
    // edit mode so the toolbar/banner don't dangle.
    useEffect(() => {
        if (edit_mode && !csv_editable) leave_edit_mode();
    }, [edit_mode, csv_editable, leave_edit_mode]);

    // Keep the store's session stamp level with the session id GridShell's hook
    // writes under. The host advances csvEditSessionId on *every* applied
    // snapshot, while a refresh only installs when it is our own current session,
    // so the id can move with no install behind it. The stamp is there to fence
    // off a *stale writer* — a hook mounted under a previous session, which is
    // what the grant's hydration-boundary comment describes — and must never
    // strand a *current* writer against a lagging stamp, which would silently
    // drop every subsequent edit. Attributing the retained map to the newly
    // adopted session preserves the retained registry map across that transition.
    //
    // useLayoutEffect, not useEffect: React runs child passive effects BEFORE the
    // parent's, so as a passive effect this would re-stamp only after GridShell's
    // own effects had already written under the new session id — and the store
    // would fence those writes off, silently dropping them. GridShell's save
    // lifecycle effect (replace_dirty) and its pendingEdits persistence effect are
    // both reachable in that window, because the host delivers csvEditSessionId
    // and csvSaveLifecycle in one snapshot. A parent layout effect runs before any
    // child passive effect, so the stamp is always level before the child writes;
    // none of GridShell's own layout effects touch the store.
    useLayoutEffect(() => {
        // Every store, not just the owning sheet's: a store the session never
        // wrote to still carries the stamp it was built with, and leaving it on a
        // retired session would fence off the first write it does receive. New
        // stores already read the moved session id ref at creation; this is the
        // commit-time half, re-stamping the stores that existed before the move.
        edit_session_registry_ref.current!.adopt_session();
    }, [csv_edit_session_id]);

    // GridShell reports the active worksheet's status; save ownership remains
    // document-scoped because every grid receives the same workbook lifecycle.
    const handle_editing_change = useCallback((status: EditingStatus) => {
        save_in_flight_ref.current = status.save_in_flight;
        set_editing_status(status);
    }, []);

    const handle_highlight_selection = useCallback((
        selection: CellHighlightSelection,
        mutation: CellHighlightMutation,
    ) => {
        const sheet = meta_ref.current?.sheets[active_sheet_index];
        const identity = snapshot_identity_ref.current;
        if (
            !sheet
            || !identity
            || preview_mode_ref.current
            || pending_highlight_request_ref.current
        ) return;
        const request_id = [
            'highlight',
            highlight_request_prefix_ref.current,
            ++highlight_request_seq_ref.current,
        ].join(':');
        pending_highlight_request_ref.current = request_id;
        set_highlight_request_pending(true);
        set_highlight_status('Updating cell highlights…');
        host_bridge.postMessage({
            type: 'applyCellHighlights',
            requestId: request_id,
            sheetIndex: active_sheet_index,
            sheetName: sheet.name,
            selection,
            mutation,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
            snapshotIdentity: identity,
        });
    }, [active_sheet_index]);

    const handle_clear_all_highlights = useCallback(() => {
        const identity = snapshot_identity_ref.current;
        if (
            !identity
            || preview_mode_ref.current
            || pending_highlight_request_ref.current
        ) return;
        const request_id = [
            'highlight',
            highlight_request_prefix_ref.current,
            ++highlight_request_seq_ref.current,
        ].join(':');
        pending_highlight_request_ref.current = request_id;
        set_highlight_request_pending(true);
        set_highlight_status('Updating cell highlights…');
        host_bridge.postMessage({
            type: 'clearAllCellHighlights',
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
            snapshotIdentity: identity,
        });
    }, []);

    const handle_toggle_tab_orientation = useCallback(() => {
        set_vertical_tabs((prev) => {
            const next = !prev;
            state_ref.current = {
                ...state_ref.current,
                tabOrientation: next ? 'vertical' : 'horizontal',
            };
            persist_immediate();
            return next;
        });
    }, [persist_immediate]);

    const deactivate_auto_fit_for_sheet = useCallback((sheet_index: number) => {
        const is_active = auto_fit_active_ref.current[sheet_index];
        const has_snapshot =
            auto_fit_snapshot_ref.current[sheet_index] !== undefined;

        if (!is_active && !has_snapshot) return;

        if (is_active) {
            set_auto_fit_active((prev) => {
                if (!prev[sheet_index]) return prev;
                const next = [...prev];
                next[sheet_index] = false;
                auto_fit_active_ref.current = next;
                return next;
            });
        }

        if (has_snapshot) {
            set_auto_fit_snapshot((prev) => {
                if (prev[sheet_index] === undefined) return prev;
                const next = [...prev];
                next[sheet_index] = undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
        }
    }, []);

    const update_column_visibility = useCallback((
        updater: ColumnVisibilityUpdater,
    ) => {
        const sheet = meta?.sheets[active_sheet_index];
        const snapshot_identity = snapshot_identity_ref.current;
        if (!sheet || !snapshot_identity) return;
        const schema = transform_schema_for_sheet(sheet);
        const current = sanitize_column_visibility_state(
            state_ref.current.columnVisibility?.[active_sheet_index],
            sheet.columnCount,
            schema,
        );
        const next_sheet_visibility = updater(
            current,
            sheet.columnCount,
            schema,
        );
        if (column_visibility_equal(current, next_sheet_visibility)) return;

        // Glide's overlay editor is portalled outside the grid. Capture its live
        // source-coordinate value before changing the displayed-column projection.
        editing_ref.current?.commit_live_edit();
        deactivate_auto_fit_for_sheet(active_sheet_index);

        const next_visibility = [
            ...(state_ref.current.columnVisibility ?? []),
        ];
        next_visibility[active_sheet_index] = next_sheet_visibility;
        state_ref.current = {
            ...state_ref.current,
            columnVisibility: next_visibility,
        };
        set_column_visibility(next_visibility);
        host_bridge.postMessage({
            type: 'setColumnVisibility',
            sheetIndex: active_sheet_index,
            sheetName: sheet.name,
            state: next_sheet_visibility,
            sourceGeneration: source_generation_ref.current,
            snapshotIdentity: snapshot_identity,
        });
        persist_immediate();
    }, [
        active_sheet_index,
        deactivate_auto_fit_for_sheet,
        meta,
        persist_immediate,
    ]);

    const handle_toggle_column = useCallback((source_index: number) => {
        update_column_visibility((current, column_count, schema) => (
            toggle_source_column(current, source_index, column_count, schema)
        ));
    }, [update_column_visibility]);

    const handle_hide_columns = useCallback((source_indexes: number[]) => {
        update_column_visibility((current, column_count, schema) => (
            hide_source_columns(current, source_indexes, column_count, schema)
        ));
    }, [update_column_visibility]);

    const handle_show_all_columns = useCallback(() => {
        update_column_visibility(() => show_all_columns());
    }, [update_column_visibility]);

    const handle_hide_all_columns = useCallback(() => {
        update_column_visibility((_current, column_count, schema) => (
            hide_all_columns(column_count, schema)
        ));
    }, [update_column_visibility]);

    const handle_column_resize = useCallback(
        (col: number, width: number) => {
            set_column_widths((prev) => {
                const next = [...prev];
                const sheet_widths = { ...(next[active_sheet_index] ?? {}) };
                sheet_widths[col] = width;
                next[active_sheet_index] = sheet_widths;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            // A direct resize supersedes both active and still-pending auto-fit.
            // Keep the current widths and discard any restore snapshot or owed fit.
            cancel_pending_auto_fit_for_sheet(active_sheet_index);
            deactivate_auto_fit_for_sheet(active_sheet_index);
        },
        [
            active_sheet_index,
            cancel_pending_auto_fit_for_sheet,
            deactivate_auto_fit_for_sheet,
            persist_immediate,
        ]
    );

    /**
     * A completed resize: paint it at once, and ask the host to persist it.
     *
     * Nothing durable is written here, and nothing is written into `state_ref` either.
     * The rows arrive as *display* intervals — a resize commits the user's whole row
     * selection, which can be select-all, so most of them may never have been loaded —
     * and mapping display→source needs the permutation plus every source row, which
     * only the host has. It maps, clamps, caps and persists; the answer comes back as a
     * new projection. That also removes the last way this panel could clobber a
     * host-written height: `rowHeights` is no longer a `stateChanged` patch leaf, and the
     * field is not even delivered, so there is no stale copy here to derive one from.
     */
    const handle_row_resize = useCallback(
        (rows: readonly DisplayRowInterval[], height: number) => {
            if (!Number.isFinite(height)) return;
            let requested_rows = 0;
            for (const interval of rows) {
                requested_rows += interval.end - interval.start + 1;
            }
            if (requested_rows === 0) return;
            // Clamped here as well as host-side, and not merely for symmetry: the overlay
            // is reconciled against the delivered projection by *value*, so an
            // unclamped optimistic height would never match the clamped height the host
            // stores, and the layer would sit there masking it. The drag itself already
            // clamps (`row-resize-model`), so this is the case that should not arise
            // rather than one that does.
            const clamped = clamp_row_height(height);
            host_bridge.postMessage({
                type: 'setRowHeights',
                sheetIndex: active_sheet_index,
                rows: rows.map((interval) => ({
                    start: interval.start,
                    end: interval.end,
                })),
                height: clamped,
                generation: generation_ref.current,
                sourceGeneration: source_generation_ref.current,
            });
            // Posted either way, but painted optimistically only when the host can
            // actually keep it. Over the cap the host refuses the whole request and warns
            // the owner, delivering nothing — so an overlay layer for it would have no
            // delivery to reconcile against and would show a height nothing persisted
            // until the generation next moved. Better to let the row spring back as the
            // drag ends, which is the truth.
            //
            // The same cap applied to the *accumulated* durable map is a refusal this
            // panel cannot predict — it never holds that map, and the projection is not a
            // proxy for its size — so that one does leave a layer with nothing behind it
            // until the generation next moves. The user is told (the host warns, naming
            // the limit); the stale rectangle is accepted rather than bought off with a
            // refusal message on the hot path of every drag. Reasoning in full at
            // `row_height_layers_for_delivery`.
            if (requested_rows > MAX_PERSISTED_ROW_HEIGHTS) return;
            set_row_height_overlay((previous) => {
                const layer: RowHeightLayer = { rows, height: clamped };
                const existing = previous[active_sheet_index];
                const next = [...previous];
                // Appended to this sheet's own overlay, and every other sheet's is left
                // exactly as it was — a resize on one sheet says nothing about a resize in
                // flight on another. Both halves of that are pinned: reading or writing
                // slot 0 instead of the active sheet's fails outright.
                //
                // The generation comparison is the exception, and is kept and labelled
                // rather than dressed up as load-bearing — the same treatment, for the same
                // reason, as the render-site generation gate below. Its stated intent is
                // that an existing overlay tagged with an older generation is replaced
                // rather than added to, its display rows having named an arrangement this
                // sheet has left. But a stale slot is unreachable by construction: the only
                // two writers of `generation_ref.current` (the `workbookSnapshot` and
                // `transformInstalled` handlers) each reach their overlay reconciliation
                // unconditionally in the same block, and that reconciliation either voids a
                // surviving overlay or rebases it onto the very generation the ref was just
                // set to. So `existing` always carries the current generation, and dropping
                // the comparison is an equivalent mutant — verified by probing it against
                // the whole of `app.test.ts`. Kept because it states the invariant the two
                // handlers are responsible for, and would be the thing that fails safe if a
                // third writer of the generation ever appeared without one.
                next[active_sheet_index] = existing
                    && existing.generation === generation_ref.current
                    ? {
                        ...existing,
                        layers: row_height_layers_with(existing.layers, layer),
                    }
                    : {
                        generation: generation_ref.current,
                        layers: [layer],
                    };
                return next;
            });
        },
        [active_sheet_index]
    );

    /**
     * Fit the active sheet now, recording the widths it replaces.
     *
     * Reads the fit through `auto_fit_ref` rather than taking widths as an argument
     * because only a *mounted* grid can measure, and all three callers — the button,
     * the all-sheets action, and the deferred pass below — run against whichever grid
     * is mounted at the time. Returns false when there was nothing to measure.
     */
    const apply_auto_fit_to_active_sheet = useCallback(() => {
        const fitted = auto_fit_ref.current?.();
        if (!fitted) return false;
        const sheet_index = active_sheet_index;
        const current_widths = column_widths[sheet_index];
        set_auto_fit_snapshot((prev) => {
            const next = [...prev];
            // Only if this sheet has no snapshot yet. A second fit over an already
            // fitted sheet must not overwrite the original widths with fitted ones,
            // or "restore" would restore the fit.
            if (next[sheet_index] === undefined) {
                next[sheet_index] = current_widths ? { ...current_widths } : undefined;
            }
            auto_fit_snapshot_ref.current = next;
            return next;
        });
        set_column_widths((prev) => {
            const next = [...prev];
            next[sheet_index] = { ...(next[sheet_index] ?? {}), ...fitted };
            state_ref.current = { ...state_ref.current, columnWidths: [...next] };
            persist_immediate();
            return next;
        });
        set_auto_fit_active((prev) => {
            const next = [...prev];
            next[sheet_index] = true;
            auto_fit_active_ref.current = next;
            return next;
        });
        return true;
    }, [active_sheet_index, column_widths, persist_immediate]);

    /**
     * Put the named sheets back on the widths their fit replaced.
     *
     * Serves both the button, which passes the active sheet alone, and the all-sheets
     * menu item. Sheets that were never fitted are skipped rather than blanked, so
     * passing every index is safe.
     */
    const restore_widths_for_sheets = useCallback((indices: readonly number[]) => {
        const fitted = indices.filter((index) => auto_fit_active_ref.current[index]);
        if (fitted.length === 0) return;
        set_column_widths((prev) => {
            const next = [...prev];
            for (const index of fitted) next[index] = auto_fit_snapshot_ref.current[index];
            state_ref.current = { ...state_ref.current, columnWidths: [...next] };
            persist_immediate();
            return next;
        });
        set_auto_fit_active((prev) => {
            const next = [...prev];
            for (const index of fitted) next[index] = false;
            auto_fit_active_ref.current = next;
            return next;
        });
        set_auto_fit_snapshot((prev) => {
            const next = [...prev];
            for (const index of fitted) next[index] = undefined;
            auto_fit_snapshot_ref.current = next;
            return next;
        });
    }, [persist_immediate]);

    const handle_toggle_auto_fit = useCallback(() => {
        if (auto_fit_active[active_sheet_index]) {
            restore_widths_for_sheets([active_sheet_index]);
        } else {
            apply_auto_fit_to_active_sheet();
        }
    }, [
        active_sheet_index,
        apply_auto_fit_to_active_sheet,
        auto_fit_active,
        restore_widths_for_sheets,
    ]);

    const auto_fit_waits_for_transform = useCallback((sheet_index: number) => {
        if (
            pending_transform_request_ids_ref.current[sheet_index]
            || pending_transforms[sheet_index]
        ) return true;
        if (preview_mode || restore_abandoned_ref.current[sheet_index]) return false;
        const sheet = meta?.sheets[sheet_index];
        if (!sheet) return false;
        const durable_transform = sanitize_transform_state(
            state_ref.current.transforms?.[sheet_index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
            sheet.sourceRowCount,
        );
        return transform_reconciliation_required(
            durable_transform,
            sheet_views[sheet_index],
        );
    }, [meta, pending_transforms, preview_mode, sheet_views, transforms]);

    const try_apply_pending_auto_fit = useCallback(() => {
        if (!pending_auto_fit_sheets_ref.current.has(active_sheet_index)) return;
        if (auto_fit_waits_for_transform(active_sheet_index)) return;
        if (!apply_auto_fit_to_active_sheet()) return;
        cancel_pending_auto_fit_for_sheet(active_sheet_index);
    }, [
        active_sheet_index,
        apply_auto_fit_to_active_sheet,
        auto_fit_waits_for_transform,
        cancel_pending_auto_fit_for_sheet,
    ]);

    useEffect(() => {
        try_apply_pending_auto_fit();
    }, [
        // A newly mounted or remounted grid is what makes the fit possible, and
        // neither identity is visible to this effect — the generation and load epoch
        // are, and they change with it. Row delivery within that mount calls the same
        // retry directly through GridShell's notification prop.
        generation,
        load_epoch,
        try_apply_pending_auto_fit,
    ]);

    const handle_auto_fit_all_sheets = useCallback(() => {
        const sheets = meta?.sheets ?? [];
        const can_eventually_measure = (index: number) => {
            const sheet = sheets[index];
            const row_count = sheet_views[index]?.rowCount ?? sheet?.rowCount ?? 0;
            return sheet !== undefined && row_count > 0 && sheet.columnCount > 0;
        };
        // The active sheet joins the queue when it could not be measured — a grid
        // with no rows loaded yet. Leaving it out on the grounds that it was "done
        // now" would make the one sheet the user is looking at the only one the
        // action skipped, with nothing left to retry it. Empty sheets are omitted:
        // they can never deliver the row sample that settles a deferred fit.
        const fitted_active = auto_fit_active_ref.current[active_sheet_index]
            || (can_eventually_measure(active_sheet_index)
                && !auto_fit_waits_for_transform(active_sheet_index)
                && apply_auto_fit_to_active_sheet());
        update_pending_auto_fit_sheets(new Set(
            sheets.map((_sheet, index) => index)
                .filter((index) => can_eventually_measure(index)
                    && (index === active_sheet_index
                        ? !fitted_active
                        : !auto_fit_active_ref.current[index])),
        ));
    }, [
        active_sheet_index,
        apply_auto_fit_to_active_sheet,
        auto_fit_waits_for_transform,
        meta,
        sheet_views,
        update_pending_auto_fit_sheets,
    ]);

    /** Restore every sheet's pre-fit widths, and drop any fit still owed. */
    const handle_restore_widths_all_sheets = useCallback(() => {
        update_pending_auto_fit_sheets(EMPTY_PENDING_AUTO_FIT);
        restore_widths_for_sheets(
            Array.from({ length: meta?.sheets.length ?? 0 }, (_, index) => index),
        );
    }, [meta, restore_widths_for_sheets, update_pending_auto_fit_sheets]);

    const current_sheet = meta?.sheets[active_sheet_index];
    const current_column_projection = useMemo(
        () => create_column_projection(
            current_sheet?.columnCount ?? 0,
            column_visibility[active_sheet_index],
            current_sheet ? transform_schema_for_sheet(current_sheet) : undefined,
        ),
        [current_sheet, column_visibility, active_sheet_index],
    );
    const current_schema = current_sheet
        ? transform_schema_for_sheet(current_sheet)
        : '';
    const column_names = useMemo(() => Array.from(
        { length: current_sheet?.columnCount ?? 0 },
        (_, index) => current_sheet?.columnNames?.[index] || column_letter(index),
    ), [current_schema]);
    const duplicate_column_names = useMemo(() => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const name of column_names) {
            const label = name.length > 0 ? name : '(blank)';
            if (seen.has(label)) duplicates.add(label);
            else seen.add(label);
        }
        return duplicates;
    }, [column_names]);
    const get_column_name = useCallback(
        (source_index: number) => column_names[source_index] ?? column_letter(source_index),
        [column_names],
    );
    const handle_preview_scroll_applied = useCallback((sequence: number) => {
        if (pending_preview_scroll_ref.current?.sequence !== sequence) return;
        set_pending_preview_scroll((current) => (
            current?.sequence === sequence ? null : current
        ));
        if (pending_preview_scroll_ref.current?.sequence === sequence) {
            pending_preview_scroll_ref.current = null;
        }
    }, []);
    const handle_preview_visible_row_change = useCallback((row: number) => {
        if (preview_mode_ref.current) last_preview_visible_row_ref.current = row;
    }, []);
    const focus_columns_trigger = useCallback(() => {
        toolbar_focus_ref.current?.focus_columns();
    }, []);

    // Host-rejected keys the store still holds. Resolving an edit (discarding it, or
    // the whole map going away) must dismiss the rejection: the host was refusing a
    // save over entries that no longer exist. Filtering here rather than in the
    // saveResult handler keeps a single source of truth — `editing_status.edits` is
    // the live map — and covers every way an entry can leave, not just our own
    // discard button.
    //
    // Memoized, and above the early returns below because it is a hook: the array
    // goes down to GridShell where it feeds the tint union's useMemo, so a fresh
    // identity every render would rebuild that Set and re-run the targeted repaint
    // effect for no change.
    const live_edits = editing_status?.edits;
    const live_rejected_keys = useMemo(
        () => {
            if (!save_rejection) return [];
            // A verdict from a previous session says nothing about this one. The
            // adoption guard at the set site only gates *recording*; the state itself
            // then had no session on it, so a rejection could ride into a new session
            // on a restored `pendingEdits` map that happens to hold the same keys.
            if (save_rejection.session_id !== csv_edit_session_id) return [];
            const on_rejected_sheet = save_rejection.worksheet_id !== undefined
                ? save_rejection.worksheet_id === current_sheet?.worksheetId
                : save_rejection.sheet_name !== undefined
                    ? save_rejection.sheet_name === current_sheet?.name
                    : save_rejection.sheet_index === active_sheet_index;
            if (!on_rejected_sheet) return [];
            return save_rejection.keys.filter((key) => {
                const live = live_edits?.[key];
                if (live === undefined) return false;
                // Identity, not membership. The key can leave the map and come back
                // as a different edit — the user discards a rejected cell and types
                // into it again, and the fresh entry's base is re-read from the file
                // the host just changed. That edit has never been submitted, so
                // claiming "save was cancelled" over it is a lie. Comparing both
                // fields is deliberate: value alone misses a re-typed identical
                // value over a new base (genuinely unjudged), and base alone misses
                // a corrected value over the same stale base.
                const judged = save_rejection.entries[key];
                return live.value === judged.value && live.base === judged.base;
            });
        },
        [
            save_rejection,
            live_edits,
            csv_edit_session_id,
            active_sheet_index,
            current_sheet?.name,
            current_sheet?.worksheetId,
        ],
    );

    if (!meta) {
        return <div className="loading">Loading...</div>;
    }

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = meta.sheets.map((s) => s.name);
    const has_multiple_sheets = meta.sheets.length > 1;
    // Scope menus exist only where "all sheets" means something. On a single-sheet
    // workbook the chevron could only restate the button, so there is none — and
    // Columns never gets one, because column visibility cannot sensibly cross sheets
    // and a chevron there would teach the wrong rule (#154).
    const all_sheets = `all ${meta.sheets.length} sheets`;
    const sheet_indices = meta.sheets.map((_, index) => index);
    const formatting_scope_menu = has_multiple_sheets
        ? {
            aria_label: 'Formatting scope',
            items: [
                {
                    label: `Show formatted values on ${all_sheets}`,
                    disabled: sheet_indices.every(
                        (index) => (show_formatting_by_sheet[index] ?? true),
                    ),
                    on_click: () => set_formatting_all_sheets(true),
                },
                {
                    label: `Show raw values on ${all_sheets}`,
                    disabled: sheet_indices.every(
                        (index) => !(show_formatting_by_sheet[index] ?? true),
                    ),
                    on_click: () => set_formatting_all_sheets(false),
                },
            ],
        }
        : undefined;
    const header_capable_sheets = meta.sheets.filter(
        (sheet) => sheet.excelFirstRowHeader !== undefined,
    );
    const excel_header_scope_menu = has_multiple_sheets && header_capable_sheets.length > 0
        ? {
            aria_label: 'Header row scope',
            items: [
                {
                    label: `Use first row as header on ${all_sheets}`,
                    disabled: edit_mode_on_active_sheet
                        || header_capable_sheets.every((sheet) =>
                            sheet.excelFirstRowHeader!.mode === 'on'
                            || sheet.excelFirstRowHeader!.active),
                    on_click: () => set_excel_header_all_sheets(true),
                },
                {
                    label: `Show first row as data on ${all_sheets}`,
                    disabled: edit_mode_on_active_sheet
                        || header_capable_sheets.every((sheet) =>
                            !(sheet.excelFirstRowHeader!.mode === 'on'
                                || sheet.excelFirstRowHeader!.active)),
                    on_click: () => set_excel_header_all_sheets(false),
                },
            ],
        }
        : undefined;
    // The orientation command is offered on a tab and on empty strip space alike —
    // as an accelerator for people who reach for right-click, never as the only
    // route in. The button on the strip remains the discoverable one (#154).
    const tab_orientation_item: MenuItem = {
        label: tab_orientation_label(vertical_tabs),
        on_click: () => {
            set_sheet_context_menu(null);
            handle_toggle_tab_orientation();
        },
    };
    const menu_sheet_index = sheet_context_menu?.sheet_index ?? null;
    const sheet_context_menu_items: MenuItem[] = !sheet_context_menu
        ? []
        : menu_sheet_index === null
        ? [tab_orientation_item]
        : [
            {
                label: 'Copy sheet',
                on_click: () => run_sheet_action(menu_sheet_index, 'copy_sheet'),
            },
            {
                label: 'Select all',
                on_click: () => run_sheet_action(menu_sheet_index, 'select_all'),
            },
            { kind: 'separator' },
            tab_orientation_item,
        ];
    const effective_vertical_tabs = vertical_tabs && has_multiple_sheets;
    const current_transform = transforms[active_sheet_index] ?? EMPTY_TRANSFORM;
    // Synchronized preview panes are shown their rows in natural source order.
    // This is preview's own rule and has nothing to do with editing: the host
    // treats it as a trust boundary because `visibleRowChanged` indexes the
    // source-line map by display row, so a permutation would scroll the text
    // editor to the wrong line (see the guard above `handle_transform_message`
    // and the `hideRows` preview reject in viewer-controller.ts).
    //
    // Edit mode, separately, no longer suppresses anything: an installed sort or
    // filter stays visible while the user edits, and deliberately does not
    // recompute, so rows keep their positions mid-edit.
    const visible_transform = preview_mode ? EMPTY_TRANSFORM : current_transform;
    const installed_view = sheet_views[active_sheet_index];
    // What the loader is actually doing, straight from the record rather than
    // re-derived from the rules: the host set it from whether it holds an index
    // permutation for this sheet.
    //
    // Its only remaining consumer in the rendered grid is merge flattening below. The
    // row-height affordances it used to suppress no longer care — heights are durable
    // against canonical source rows and arrive already projected into display space — so
    // `GridShell` is not told about it at all, and the merge decision is made here rather
    // than there. If you are looking for what a permutation still *changes* on screen,
    // `merges` is the answer.
    const transform_active = installed_view?.permuted ?? false;
    const any_transform_pending = pending_transforms.some(Boolean);
    const has_hidden_columns =
        current_column_projection.visible_to_source.length
        < current_sheet.columnCount;
    const merges_flattened =
        current_sheet.merges.length > 0
        && (transform_active || has_hidden_columns);
    const transform_pending = pending_transforms[active_sheet_index] ?? false;
    const hidden_row_count = visible_transform.hiddenRows?.length ?? 0;
    const show_formatting = show_formatting_by_sheet[active_sheet_index] ?? true;
    const excel_header = current_sheet.excelFirstRowHeader;
    const excel_header_candidate_available = current_sheet.columnCount > 0
        && hidden_row_count < current_sheet.sourceRowCount;
    const excel_header_pending = pending_excel_header !== null;
    const excel_header_disabled = !!excel_header && (
        (!excel_header_candidate_available
            && !excel_header.active
            && excel_header.mode !== 'on')
        || edit_mode_on_active_sheet
        || any_transform_pending
        || excel_header_pending
    );
    const excel_header_disabled_reason = !excel_header_candidate_available
        && !excel_header?.active
        ? 'This sheet has no first row to use as column names.'
        : excel_header_pending
        ? pending_excel_header_unhide_ref.current
            ? 'Restoring rows…'
            : pending_excel_header_promote_ref.current
            ? 'Making row header…'
            : 'Updating column names…'
        : edit_mode_on_active_sheet
        ? 'Exit Edit mode before changing the header row.'
        : 'Wait for sorting and filtering to finish.';
    const effective_row_count = installed_view?.rowCount ?? current_sheet.rowCount;
    const visibility_reset_key = [
        load_epoch,
        active_sheet_index,
        transform_schema_for_sheet(current_sheet),
    ].join(':');
    const no_visible_columns =
        current_column_projection.visible_to_source.length === 0;

    const auto_fit_scope_menu = has_multiple_sheets
        ? {
            aria_label: 'Auto-fit scope',
            items: [
                {
                    label: `Auto-fit columns on ${all_sheets}`,
                    disabled: no_visible_columns
                        || transform_pending
                        || sheet_indices.every((index) => auto_fit_active[index]),
                    on_click: handle_auto_fit_all_sheets,
                },
                {
                    // Dead until something has been fitted — restoring widths nobody
                    // changed is the definition of an action that does nothing. A fit
                    // that is only *owed* counts: it will apply as each sheet is
                    // opened, and calling it off is the one thing this item can do
                    // that nothing else can.
                    label: `Restore original widths on ${all_sheets}`,
                    disabled: pending_auto_fit_sheets.size === 0
                        && !sheet_indices.some((index) => auto_fit_active[index]),
                    on_click: handle_restore_widths_all_sheets,
                },
            ],
        }
        : undefined;

    /**
     * The one reason set that hides or disables transform affordances, shared by
     * the grid's header sections and the toolbar so the two can never disagree.
     * Edit mode is deliberately absent — sorting and filtering stay available
     * while editing. What remains are the windows in which the host would refuse
     * the request anyway (a save in flight, a claim mid-flight) or in which the
     * displayed order is not the user's to change (preview, an Excel header
     * change reshaping the rows underneath).
     */
    // The save term is read from the authoritative workbook lifecycle, not only
    // from the mounted grid's report. The lifecycle is document-scoped, so these
    // controls must remain fenced when any worksheet participates in the save,
    // including a sibling-only operation the current grid does not hydrate.
    // These two have to name the same condition or the UI is lying about it.
    const transform_ui_blocked =
        save_lifecycle.state === 'active'
        || editing_status?.save_in_flight === true
        || edit_session_pending
        || preview_mode
        || excel_header_pending;

    // Stale-view banner: derived from the rules actually *installed* in the grid, not
    // the requested ones, because the statement is about the order the user is
    // looking at. Only meaningful in edit mode — outside it the order recomputes as
    // normal.
    //
    // The hidden cells ride the same record, so they need no state of their own and
    // cannot disagree with the rules they were computed against. No `edit_mode` term
    // of their own either: the signature below carries the only one there should be,
    // and the message is rendered only when the banner is. Probed rather than assumed
    // — a second copy of that gate here fails no test, which makes it a guard nothing
    // could hold to account. The one below is now pinned: see "goes silent when edit
    // mode ends with the dirty map still reported", which deleting it fails.
    //
    // Narrowed to keys the dirty map still holds, which is the *subtracting* half of
    // keeping this current. The host answers membership, which only an install can
    // change; the number of hidden cells depends on the edit set too, and that moves
    // with every `pendingEditsChanged`, discard and save — none of which install
    // anything, so a count from the host would go on claiming a discarded edit is out
    // of sight forever. An entry that left the dirty map is not out of sight, it is
    // gone, so subtracting it here is exact and needs no message from the host.
    //
    // The adding half is not here and cannot be: it needs view membership, which never
    // reaches the webview. An edit typed while a hiding transform computed is missing
    // from the install's own answer for good, so the host re-answers on every delivery
    // and the snapshot handler takes the fresh keys onto the record it keeps — see
    // `view_record_with_hidden_keys`. This intersection then subtracts from *that*.
    //
    // Membership in the map, not identity of the entry — deliberately unlike
    // `live_rejected_keys` above, which compares value and base because a re-typed
    // cell has never been judged. Here the question is only whether unsaved work is
    // still sitting in a row the user cannot see, and a hidden row's cell cannot be
    // re-typed to begin with.
    //
    // Silent until GridShell's first status report lands, since `live_edits` is that
    // report. The column half already waits on the same map, so the notice speaks as
    // one fact over one dirty map rather than half of it arriving early.
    // Only a permutation has rules and hidden rows to speak about. A non-permuted
    // record carries neither, structurally, so both halves below fall silent on it
    // without a guard of their own — which is right: the host applied nothing, so
    // there is no installed order to be stale and no row it fails to show.
    const installed_rules = installed_view?.permuted
        ? installed_view.rules
        : undefined;
    const hidden_edited_cell_keys = (installed_view?.permuted
        ? installed_view.hiddenEditedCellKeys
        : []).filter((key) => live_edits?.[key] !== undefined);
    const hidden_edited_cells = hidden_edited_cell_keys.length;
    const dirty_keys = Object.keys(live_edits ?? {});
    // The first sentence's own reason, from the same list the signature folds in.
    const order_relevant_edits = order_relevant_dirty_keys(
        installed_rules,
        dirty_keys,
    );
    const stale_view_current_signature = edit_mode_on_active_sheet
        ? stale_view_signature(
            installed_rules,
            dirty_keys,
            hidden_edited_cell_keys,
        )
        : undefined;
    const show_stale_view_banner = stale_view_current_signature !== undefined
        && stale_view_current_signature !== acknowledged_stale_signature;
    // One notice, two independent facts, one sentence each — and each sentence
    // rendered only when its own fact holds, so either can stand alone. The first was
    // unconditional and was false of a view permuted by `hiddenRows` alone: nothing
    // was sorted and nothing was filtered, so there was no order not updating. It now
    // speaks only when an unsaved edit sits in a column the installed order actually
    // reads, which is the only case in which the displayed order can disagree with the
    // values.
    //
    // Both are statements, not prompts: they say what the view is doing and where the
    // unsaved work is, and nothing about doing anything with either. Noun and verb in
    // the second are pluralized as one phrase, as in conflict_banner_message, so
    // "1 edited cells are" cannot be written.
    //
    // "doesn't show" rather than "hides" because the host names every edited row the
    // view does not contain, and one of those is a row an external shrink removed —
    // not hidden, gone. The weaker verb is true of both, and both are the same fact
    // for the user: unsaved work they cannot see.
    const stale_view_message = [
        ...(order_relevant_edits.length > 0
            ? ['Sorting and filters don\'t update while you\'re editing.']
            : []),
        ...(hidden_edited_cells > 0
            ? [hidden_edited_cells === 1
                ? '1 edited cell is in a row this view doesn\'t show.'
                : `${hidden_edited_cells} edited cells are in rows this view doesn't show.`]
            : []),
    ].join(' ');

    // Conflict banner: a stable signature of the conflicted cell set, so dismissing
    // it ("Keep All") sticks until a *different* set of cells drifts.
    const conflicted_keys = editing_status?.conflicted ?? [];
    const conflict_signature = [...conflicted_keys].sort().join(',');
    const show_host_rejection = edit_mode_on_active_sheet
        && live_rejected_keys.length > 0;
    // A host rejection is an *independent* reason to render, because the keys it
    // names are exactly the ones the webview's residency-gated detection cannot
    // flag: requiring conflicted_keys.length > 0 would leave the banner (and every
    // exit it offers) unreachable in precisely the case that needs it.
    //
    // The dismissal gate applies to both reasons, not just the derived one. With the
    // rejection short-circuiting ahead of it, "Keep All" was a no-op for a host
    // rejection — it recorded a signature nothing consulted, and the banner stayed
    // up with no way to put it away short of discarding the edits. A dismissal here
    // is safe because it cannot outlive the verdict: every save result clears both
    // (see clear_save_verdict).
    const show_conflict_banner =
        edit_mode_on_active_sheet
        && (show_host_rejection || conflicted_keys.length > 0)
        && conflict_signature !== dismissed_conflict_signature;
    // Conflicts the *webview* derived and the host did not name. `conflicted_keys` is
    // already the union of both sources (GridShell merges them so one set drives all
    // tinting), so this difference is what's left for discard_conflicted to do once
    // discard_keys has taken the host's share — including nothing, when the rejection
    // is the only reason the banner is up.
    const derived_only_conflicts = show_host_rejection
        ? conflicted_keys.filter((key) => !live_rejected_keys.includes(key))
        : conflicted_keys;
    const removed_rows = show_host_rejection
        && save_rejection?.reason === 'rowsRemoved'
        ? rejected_rows(live_rejected_keys)
        : [];
    const conflict_banner_message = removed_rows.length > 0
        // Name the rows. For a removed row there is nothing to highlight — the grid
        // is given the shrunk row count, so the cell does not exist to paint — and
        // for the same reason the *values* cannot be shown either. The row numbers
        // are all the user has to go on. Counted in rows, not keys: several edits on
        // one vanished row are one row lost.
        // Verb agrees with the count, so the noun and the verb are pluralized as one
        // phrase rather than the noun alone ("1 edited row no longer exist").
        ? `File shrank externally. ${
            removed_rows.length === 1
                ? '1 edited row no longer exists'
                : `${removed_rows.length} edited rows no longer exist`
        } — save was cancelled. Affected row${
            removed_rows.length === 1 ? '' : 's'
        }: ${removed_rows.join(', ')}.`
        : show_host_rejection
            ? `File changed externally. ${
                live_rejected_keys.length === 1
                    ? '1 edit no longer matches'
                    : `${live_rejected_keys.length} edits no longer match`
            } the file — save was cancelled. Highlighted cells show conflicts.`
            : `File changed externally. ${conflicted_keys.length} edit${
                conflicted_keys.length === 1 ? '' : 's'
            } may be affected — highlighted cells show conflicts.`;

    // The overlay only ever applies to the sheet and the arrangement it was recorded
    // against.
    //
    // The *sheet* part is settled by reading the active sheet's own slot, which is why the
    // overlays are held per sheet rather than as one record carrying the sheet it belongs
    // to. A tab switch moves no generation and touches no overlay state, so nothing written
    // at the two handlers could catch it; painting whatever overlay happened to be in state
    // would show a pending resize on Sheet1 at display rows 3, 5 and 8 of whatever sheet the
    // user opens next.
    //
    // The *generation* test remains unfalsifiable, and is kept and labelled rather than
    // dressed up as load-bearing. Both writers of `generation`
    // (`workbookSnapshot`, `transformInstalled`) now run `retained_row_height_overlay` in
    // the same handler and therefore the same React batch, and that helper either voids the
    // overlay or rebases it onto the generation being installed — so an overlay whose
    // generation is not the current one cannot be observed here. Mutation testing agrees:
    // deleting this line fails nothing. It stays as the cheap guard on that invariant,
    // which is a property of two call sites agreeing rather than of anything local, and on
    // the precedent of the other deliberately unfalsifiable guards in this PR
    // (`adopt_source`'s memo clear). Previously it was described as *jointly* held with the
    // install path's same-sheet void; that pairing is gone, because the void moved into the
    // shared helper where unit tests kill it directly.
    const overlay_for_active_sheet = row_height_overlay[active_sheet_index];
    const active_row_height_overlay =
        overlay_for_active_sheet
        && overlay_for_active_sheet.generation === generation
            ? overlay_for_active_sheet.layers
            : undefined;

    const grid = (
        <GridShell
            key={`${active_sheet_index}:${current_sheet.worksheetId ?? current_sheet.name}:${load_epoch}:${generation}`}
            sheet_meta={current_sheet}
            sheet_index={active_sheet_index}
            generation={generation}
            row_count={effective_row_count}
            show_formatting={show_formatting}
            column_projection={current_column_projection}
            column_widths={column_widths[active_sheet_index] ?? {}}
            on_column_resize={handle_column_resize}
            // The host's display-keyed projection for this sheet — never `{}` under a
            // permutation, which is what the old `transform_active ? {} : …` did to keep a
            // display-keyed durable map from naming the wrong rows. The projection is
            // computed against the installed permutation, so it is correct in exactly the
            // case the suppression existed for.
            row_heights={row_height_projection[active_sheet_index] ?? {}}
            row_height_overlay={active_row_height_overlay}
            on_row_resize={handle_row_resize}
            merges={merges_flattened ? [] : current_sheet.merges}
            preview_mode={preview_mode}
            edit_mode={edit_mode_on_active_sheet}
            csv_editable={csv_editable}
            edit_session_id={csv_edit_session_id}
            // Save lifecycle is workbook-scoped so it fences every grid; edit
            // stores remain worksheet-scoped so cell keys never cross sheets.
            save_operation={save_operation}
            save_lifecycle={save_lifecycle}
            on_save_request={begin_save_operation}
            edit_session={edit_session_registry_ref.current!.for_sheet(
                active_sheet_index,
            )}
            host_rejected_keys={live_rejected_keys}
            on_editing_change={handle_editing_change}
            editing_ref={editing_ref}
            auto_fit_ref={auto_fit_ref}
            on_auto_fit_sample_change={
                pending_auto_fit_sheets.has(active_sheet_index)
                    ? try_apply_pending_auto_fit
                    : undefined
            }
            grid_focus_ref={grid_focus_ref}
            grid_actions_ref={grid_actions_ref}
            pending_preview_scroll={pending_preview_scroll}
            on_preview_scroll_applied={handle_preview_scroll_applied}
            on_preview_visible_row_change={handle_preview_visible_row_change}
            transform_state={visible_transform}
            transform_sections={!transform_ui_blocked}
            transform_pending={transform_pending}
            on_transform_change={handle_grid_transform_change}
            on_open_filter={open_grid_filter_editor}
            on_hide_column={handle_toggle_column}
            on_hide_columns={handle_hide_columns}
            on_hide_rows={handle_hide_rows}
            can_promote_row_to_header={
                excel_header !== undefined && !edit_mode_on_active_sheet
            }
            on_promote_row_to_header={handle_promote_row_to_header}
            on_focus_columns={focus_columns_trigger}
            cell_highlights={cell_highlights?.sheets[active_sheet_index]}
            on_highlight_selection={handle_highlight_selection}
            on_highlight_selection_available_change={set_highlight_selection_available}
            highlight_ref={highlight_ref}
        />
    );

    // Sort, filter, row hiding and the merge notice — worksheet state, so it sits
    // with the worksheet's pane below the tabs rather than in the workbook chrome
    // above them (#154). Renders nothing when the view is untransformed.
    const sheet_pane = (
        <div className="sheet-pane">
            <StateStrip
                transform={visible_transform}
                transform_disabled={transform_ui_blocked}
                transform_pending={transform_pending}
                transform_progress={pending_transform_labels[active_sheet_index]}
                hidden_rows={{
                    count: hidden_row_count,
                    pending: transform_pending,
                    disabled: edit_mode_on_active_sheet
                        && excel_header?.mode === 'on'
                        && excel_header.sourceRow !== 0,
                    on_unhide_all: handle_unhide_all_rows,
                }}
                column_names={column_names}
                merges_flattened={merges_flattened}
                on_transform_change={handle_toolbar_transform_change}
                on_edit_filter={(entry, trigger) => {
                    const rect = trigger.getBoundingClientRect();
                    open_filter_editor(
                        entry.colIndex,
                        { left: rect.left, top: rect.bottom + 4 },
                        () => trigger.focus(),
                        // Still 'toolbar': the origin discriminates a chip-opened
                        // editor from a header-opened one, and the chips only
                        // changed which row they live on.
                        'toolbar',
                    );
                }}
                on_cancel_transform={handle_cancel_transform}
            />
            {grid}
        </div>
    );

    return (
        <div className={`viewer ${effective_vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                ref={toolbar_focus_ref}
                show_formatting={show_formatting}
                on_toggle_formatting={handle_toggle_formatting}
                show_formatting_button={meta.hasFormatting}
                formatting_scope_menu={formatting_scope_menu}
                show_excel_header_button={excel_header !== undefined}
                excel_header_active={excel_header?.mode === 'on'
                    || excel_header?.active === true}
                excel_header_automatic={excel_header?.mode === 'auto'}
                excel_header_pending={excel_header_pending}
                excel_header_status={excel_header_status}
                on_toggle_excel_header={handle_toggle_excel_header}
                excel_header_disabled={excel_header_disabled}
                excel_header_disabled_reason={excel_header_disabled_reason}
                excel_header_scope_menu={excel_header_scope_menu}
                highlight={{
                    active_color: active_highlight_color,
                    on_color_change: set_active_highlight_color,
                    on_apply: () => highlight_ref.current?.apply(active_highlight_color),
                    on_clear: () => highlight_ref.current?.clear(),
                    on_clear_all: handle_clear_all_highlights,
                    selection_available: highlight_selection_available,
                    pending: highlight_request_pending,
                    disabled: preview_mode,
                    status: highlight_status,
                }}
                column_visibility={{
                    column_count: current_sheet.columnCount,
                    get_column_name,
                    duplicate_names: duplicate_column_names,
                    is_visible: (source_index) =>
                        current_column_projection.source_to_visible[source_index] !== undefined,
                    hidden_count: current_column_projection.hidden_count,
                    reset_key: visibility_reset_key,
                    on_toggle: handle_toggle_column,
                    on_show_all: handle_show_all_columns,
                    on_hide_all: handle_hide_all_columns,
                    disabled: current_sheet.columnCount === 0,
                }}
                auto_fit_active={auto_fit_active[active_sheet_index] ?? false}
                on_toggle_auto_fit={handle_toggle_auto_fit}
                auto_fit_scope_menu={auto_fit_scope_menu}
                auto_fit_disabled={no_visible_columns || transform_pending}
                auto_fit_disabled_reason={
                    no_visible_columns
                        ? current_sheet.columnCount === 0
                            ? 'No columns are available to auto-fit.'
                            : 'Show at least one column before using auto-fit.'
                        : 'Wait for sorting and filtering to finish.'
                }
                edit_mode={edit_mode_on_active_sheet}
                is_dirty={edit_session_registry_ref.current!.has_dirty_entries()}
                on_toggle_edit_mode={handle_toggle_edit_mode}
                show_edit_button={csv_editing_supported}
                // `transform_active` is deliberately absent: an *installed* sort,
                // filter, or row-hiding rule no longer disables Edit. Edits are
                // source-keyed (#110) and an installed permutation never
                // recomputes during a session, so entering edit mode under one
                // moves no rows. `transform_pending` — work in flight — still
                // disables, matching the host's own transient refusal.
                edit_disabled={
                    save_lifecycle.state === 'active'
                    || editing_status?.save_in_flight === true
                    // `csvEditable` is also false while another panel owns the
                    // workbook session, where pressing Edit is how this panel asks
                    // for ownership. Truncation is different: no request can make a
                    // partial source editable, so its visible banner is the narrow
                    // condition that makes this control genuinely disabled.
                    || (!!truncation_message && !csv_editable)
                    // The session covers the whole workbook, so a session open on
                    // another worksheet no longer disables this sheet's Edit
                    // button — pressing it continues the same session here. Only
                    // entering is gated: on a claim already in flight, and on
                    // transform work the host would refuse anyway.
                    || (!edit_mode_on_active_sheet && (
                        edit_session_pending
                        || transform_pending
                    ))
                }
                edit_disabled_reason={
                    save_lifecycle.state === 'active'
                    || editing_status?.save_in_flight
                        ? 'Saving changes.'
                        : truncation_message && !csv_editable
                        ? 'Editing is disabled until all rows are loaded.'
                        : edit_session_pending
                        ? 'Waiting to enter edit mode.'
                        // Transform work in flight is the only disabler left.
                        : 'Wait for sorting and filtering to finish.'
                }
            />
            {filter_editor && (
                <FilterPopover
                    key={`${source_generation_ref.current}:${active_sheet_index}:${filter_editor.column_index}`}
                    column_index={filter_editor.column_index}
                    column_name={column_names[filter_editor.column_index]
                        ?? `Column ${filter_editor.column_index + 1}`}
                    filters={visible_transform.filters}
                    anchor={filter_editor.anchor}
                    histogram={filter_histogram.key === `${source_generation_ref.current}:${active_sheet_index}:${filter_editor.column_index}`
                        ? filter_histogram.value
                        : { status: 'loading' }}
                    on_apply={apply_filter_editor}
                    on_cancel={(reason) => close_filter_editor(
                        reason === 'escape' || reason === 'explicit',
                    )}
                    on_remove={remove_filter_editor}
                />
            )}
            {truncation_message && (
                <div className="truncation-banner">
                    <div className="truncation-banner-copy">
                        <div>{truncation_message}</div>
                        <div className="truncation-banner-detail">
                            {csv_editing_supported && !csv_editable
                                ? 'Editing is disabled until all rows are loaded.'
                                : 'Additional rows were not loaded.'}
                        </div>
                    </div>
                    <div className="truncation-banner-actions">
                        <button
                            type="button"
                            className="truncation-setting-action"
                            title="Change the CSV/TSV row limit in settings, then reload the file."
                            onClick={() => host_bridge.postMessage({
                                type: 'openCsvRowLimitSetting',
                            })}
                        >
                            Change row limit
                        </button>
                        <button
                            type="button"
                            className="truncation-load-action"
                            onClick={() => host_bridge.postMessage({
                                type: 'loadAllCsvRows',
                            })}
                        >
                            Load all rows
                        </button>
                    </div>
                </div>
            )}
            {show_stale_view_banner && (
                // Informational only. Deliberately no "Resort"/"Refilter"/"Refresh"
                // action: rows staying where the user left them is the feature, so
                // there is nothing to fix and nothing to apply. Dismiss records the
                // acknowledgement and touches nothing else. Rendered outside the
                // content area holding the grid so it never joins GridShell's
                // remount key.
                //
                // A polite live region: it appears in response to typing rather than
                // to an explicit action, so without role="status" a screen-reader
                // user gets no signal it is there. Announced once, without taking
                // focus from the cell being edited.
                <div className="stale-view-banner" role="status">
                    {stale_view_message}
                    <div className="stale-view-banner-actions">
                        <button
                            onClick={() => set_acknowledged_stale_signature(
                                stale_view_current_signature,
                            )}
                        >
                            Dismiss
                        </button>
                    </div>
                </div>
            )}
            {show_conflict_banner && (
                <div className="conflict-banner">
                    {conflict_banner_message}
                    <div className="conflict-banner-actions">
                        <button
                            onClick={() =>
                                set_dismissed_conflict_signature(conflict_signature)
                            }
                        >
                            Keep All
                        </button>
                        <button
                            onClick={() => {
                                // Two mechanisms, one label — and both may be needed
                                // in the same press. discard_conflicted is a retain
                                // over is_entry_conflicted, which is false for every
                                // host-named key, so it alone would keep the entry
                                // that is blocking the save; discard_keys names only
                                // the host's. The grid tints the *union* of the two
                                // sets, so a press that cleared only one of them
                                // would leave the banner up over still-tinted cells
                                // and demand a second press for the other half.
                                //
                                // Ordering is safe in either direction: both store
                                // operations read the live entry map rather than a
                                // captured snapshot, so the retain sees the map with
                                // the host keys already gone.
                                if (show_host_rejection) {
                                    editing_ref.current?.discard_keys(live_rejected_keys);
                                }
                                if (derived_only_conflicts.length > 0) {
                                    editing_ref.current?.discard_conflicted();
                                }
                            }}
                        >
                            Discard Conflicted
                        </button>
                        <button
                            onClick={() => {
                                editing_ref.current?.clear_dirty();
                                discard_edit_session();
                            }}
                        >
                            Discard All
                        </button>
                    </div>
                </div>
            )}
            {/*
              * The tabs come first in both arrangements and the pane follows, so the
              * state strip is always below them: vertically the rail runs the full
              * height and the strip is a header on the grid pane, which is what makes
              * it read as belonging to the selected sheet rather than to the window.
              */}
            {effective_vertical_tabs ? (
                <div className="content-area">
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        on_context_menu={handle_sheet_context_menu}
                        on_strip_context_menu={handle_strip_context_menu}
                        on_toggle_orientation={handle_toggle_tab_orientation}
                        vertical={true}
                    />
                    {sheet_pane}
                </div>
            ) : (
                <>
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        on_context_menu={handle_sheet_context_menu}
                        on_strip_context_menu={handle_strip_context_menu}
                        on_toggle_orientation={handle_toggle_tab_orientation}
                        vertical={false}
                    />
                    {sheet_pane}
                </>
            )}
            {sheet_context_menu && (
                <ContextMenu
                    x={sheet_context_menu.x}
                    y={sheet_context_menu.y}
                    aria_label={menu_sheet_index === null
                        ? 'Sheet tab actions'
                        : `Sheet actions for ${
                            sheet_names[menu_sheet_index]
                            ?? `Sheet ${menu_sheet_index + 1}`
                        }`}
                    items={sheet_context_menu_items}
                    on_dismiss={() => set_sheet_context_menu(null)}
                    restore_focus={() => {
                        if (menu_sheet_index === null) return;
                        document.querySelectorAll<HTMLElement>('.sheet-tab')
                            .item(menu_sheet_index)?.focus();
                    }}
                />
            )}
        </div>
    );
}
