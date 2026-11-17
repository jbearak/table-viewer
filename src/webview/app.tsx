import { cell_key, parse_cell_key } from '../cell-key';
import { perf_mark } from './perf-marks';
import {
    begin_view_action,
    cancel_view_action,
    choose_in_view_action,
    install_in_view_action,
    refresh_view_action,
    resend_in_view_action,
    settle_view_action,
    transforms_semantically_equal,
    view_action_owns,
    type ViewAction,
} from './view-action-model';
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
    is_wire_csv_save_rejection,
    pending_edits_for_sheet,
    pending_changes_for_sheet,
    sheet_index_with_pending_edits,
    transform_has_entries,
    transform_is_active,
    transform_schema_for_sheet,
    with_pending_edits_for_sheet,
    worksheet_target_index,
    worksheet_target_key,
    worksheet_target_lookup,
    WEBVIEW_STRUCTURAL_LAYOUT_VERSION,
    type CellHighlightColor,
    type CellHighlightMutation,
    type CellHighlightSelection,
    type CellHighlightState,
    type HighlightCellDelta,
    dirty_entries_equal,
    copy_dirty_entry,
    dirty_entry_base_formatting_unknown,
    dirty_entry_value_dimension_present,
    dirty_entry_with_observed_file_base,
    dirty_move_component_sizes,
    type CsvDirtyEntry,
    type CsvObservedFileBase,
    type PendingChangesSaveReceipt,
    type StructuralSaveUnresolvedNotice,
    receipt_has_structure,
    structure_row_mapper,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type CsvSaveWorksheetOperation,
    type DisplayRowInterval,
    type PerFileState,
    type ScrollPosition,
    type SheetPendingEditCells,
    type HistoryMenuProjection,
    type HostMessage,
    type SheetTransformState,
    type FilterEntry,
    type SheetColumnVisibilityState,
    type SheetViewRecord,
    type TransformIntent,
    type ViewBasis,
    type WorksheetTarget,
    type ExcelHeaderTarget,
    type WorksheetPendingChanges,
    type ColumnWidthsSheetChange,
} from '../types';
import type { WorkbookMeta } from '../data-source/interface';
import { header_body_start } from '../worksheet-layout';
import { header_rebase_slot_refusal } from '../header-rebase';
import { in_range_rows } from '../header-hidden-rows';
import {
    advance_pending_append_basis,
    assert_pending_changes_encoded_bound,
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    has_live_layout_change,
    type PendingAppendBasis,
    type PendingStructuralChanges,
    type PendingStructuralConflict,
    pending_rows,
    appended_rows,
    pending_changes_carry_layout,
    pending_layout_fields,
} from '../pending-changes';
import {
    hyperlinks_equal,
    normalize_rich_text,
    rich_text_formatting_equal,
    rich_text_from_plain,
    rich_text_has_styles,
    type CellHyperlink,
    type RichText,
} from '../cell-content';
import {
    all_workbook_formula_cells_impact,
    workbook_impact_with_cells,
    compile_workbook_formula_graph,
    pending_workbook_formula_targets,
    plan_workbook_formula_recalculation,
    STRUCTURED_REFERENCE_STRIDE,
} from '../formula-dependencies';
import { committed_column_name } from '../column-name';
import {
    displayed_formula_result,
    type FormulaCalculationAddress,
    type FormulaCalculationEdit,
} from '../formula-calculation';
import {
    compile_a1_formula_move_retargeter,
    retarget_renamed_structured_formula,
} from '../xlsx-formula';
import { xlsx_edit_writes_formula } from '../xlsx-cell-value';
import {
    MAX_SHEET_ROWS,
    MAX_WORKBOOK_FORMULAS,
    UNBOUNDED_SHEET_ROWS,
} from '../spreadsheet-safety';
import { prospective_cell_at, referenced_pending_ids } from '../formula-anchor-layout';
import {
    is_conflict_dismissal,
    pending_change_notices,
    renamed_source_columns,
    save_summary,
    saved_cell_edit_count,
    short_rows_note,
    worksheet_structure_counts,
    type PendingChangeFormulaImpact,
    type PendingChangeNoticeIntent,
    type PendingChangeNoticeWorksheet,
} from './pending-change-notices';
import { PendingChangeNotices } from './pending-change-notices-view';
import { use_host_question } from './host-question';
import type { FormulaDivergenceReview, FormulaImpact, FormulaImpactState } from '../formula-divergence-review';
import {
    layout_affected_formula_cells,
    needs_prospective_formula_request,
    prospective_formula_request,
    prospective_formula_targets,
    webview_formula_workbook,
} from './formula-anchor-model';
import { use_pending_snapshot } from './pending-snapshot';
import { capture_pending_formula_reference_bases } from '../pending-formula-rebase';
import {
    classify_snapshot,
    normalize_complete_per_file_state,
    normalize_workbook_snapshot_state,
    type ExcelHeaderSnapshotResult,
    type RetainedSnapshotCommandResult,
    type StructuralEditingCapability,
    type UnresolvedLfsObject,
    type WorkbookSnapshot,
    type WorkbookSnapshotCompare,
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
import { SheetTabs, tab_orientation_label, type SheetTabBadge } from './sheet-tabs';
import { StateStrip } from './state-strip';
import { CompareProgress } from './compare-progress';
import { CompareStrip } from './compare-strip';
import { LfsBanner } from './lfs-banner';
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
    type AppendRowsAdmission,
    type StructuralColumnInsertAdmission,
    type StructuralColumnInsertRequest,
    type StructuralInsertAdmission,
    type StructuralInsertRequest,
    type GridActionsHandle,
    type GridFocusHandle,
    type HighlightSelectionHandle,
    type PendingPreviewScroll,
    type PendingHostGesture,
    type CellFocus,
    type PendingRowFocus,
    type SavedRowFocus,
} from './grid-shell';
import {
    EMPTY_APPEND_COMPOSER_DRAFT,
    type AppendComposerDraft,
} from './append-composer';
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
    remove_operation_owned_pending_edits,
    remove_operation_owned_pending_structural_changes,
    resolve_csv_save_hydration_from_worksheets,
    resolve_csv_save_structural_hydration_from_worksheets,
    save_lifecycle_correlation,
    save_operation_worksheets,
    saved_history_cells,
    terminal_csv_save_settles_operation,
    type CsvSaveProjection,
} from './csv-save-lifecycle';
import {
    create_edit_session_registry,
    type EditSessionRegistry,
} from './edit-session-registry';
import type { DirtyEntry, StoreWrite } from './edit-session-store';
import {
    create_history_store,
    type HistoryStore,
    type StagedHistoryRecord,
} from './history-store';
import { discard_history_source } from './history-discard-model';
import {
    create_history_replay_coordinator,
    type AcceptedReplay,
    type HistoryReplayCoordinator,
    type ReplayOutcome,
} from './history-replay-coordinator';
import {
    COLUMN_WRITE_REFUSED_MESSAGE,
    FOLD_REFUSED_MESSAGE,
    REDO_REPLACED_BY_FOLD_MESSAGE,
    REOPEN_REQUIRED_MESSAGE,
    REOPEN_REQUIRED_SAVE_MESSAGE,
    SIZE_WRITE_REFUSED_MESSAGE,
    SIZE_WRITE_UNRESOLVED_MESSAGE,
    UNRESOLVED_SAVE_SIZE_REASON,
    VIEW_GESTURE_WAIT_MESSAGE,
    history_gesture_unrecorded_warning,
    history_session_unavailable_warning,
    history_unanswered_warning,
    header_wait_warning,
    history_refusal_warning,
    replayed_verb,
    view_partly_applied_warning,
    view_replay_dropped_warning,
    view_replay_refusal_warning,
    view_replay_wait_warning,
    view_skip_warning,
    type ViewReplayWait,
} from './history-command-model';
import {
    HISTORY_PRESS_HOLD_MS,
    history_message_is_repeat,
    history_press_bound_reached,
    history_press_gate,
    press_admits_ticket,
    view_step_press_gate,
    type HistoryPress,
    type HistoryPressFacts,
    type HistoryPressGate,
    type HistoryPressWait,
} from './history-press-model';
import {
    auto_fit_after_width_replay,
    column_widths_label,
    column_widths_replay_target,
    column_widths_view_step,
    columns_replay_target,
    columns_view_step,
    header_replay_target,
    header_step_label,
    header_view_delta,
    ordered_skips,
    overtaken_transform_step,
    row_heights_replay_target,
    row_heights_view_step,
    transform_replay_target,
    transform_slices_equal,
    transform_view_step,
    type AutoFitChange,
    type HeaderViewDelta,
    type TransformViewDelta,
    type ViewHistoryDelta,
    type ViewSkipReason,
    type ViewStep,
} from './view-history-model';
import { entry_for_current_header, type HeaderSheet, type HeaderWait } from './history-header-rebase';
import {
    history_menu_projection,
    history_menu_projections_equal,
} from './history-menu-projection';
import {
    history_focus_request,
    replay_focus_is_shown_header,
    type HistoryFocusOutcome,
    type PendingHistoryFocus,
} from './history-focus-model';
import {
    replayed_store_entry,
    wire_entry_for_destination,
} from './history-replay-request-model';
import {
    absent_overlay,
    overlay_state_from_dirty_entry,
    type HistoryDirection,
} from './history-cell-state-model';
import {
    peek_history,
    action_has_view_change,
    view_step_change,
    width_step_changes,
    header_step_changes,
    retained_pending_row_authorities,
    is_structural_history_change,
    retained_saved_append_authorities,
    type HistoryBarrier,
    type HistoryEntry,
    type SavedHistoryCell,
} from './history-stack-model';
import {
    plan_pending_row_history_replay,
    type PendingRowHistoryPlan,
} from './pending-row-history';
import {
    HISTORY_REPLAY_LEASE_TTL_MS,
    type HistoryReplayCommitted,
} from '../history-replay-protocol';
import { pending_signal, type PendingSignal } from './pending-signal';
import { run_discard_transaction } from './discard-transaction-model';
import { highlight_history_source } from './highlight-capture-model';
import { commit_staged_transaction, type StagedMutation } from './staged-mutation';
import { discard_layout_changes, keep_inserted_rows_at_end } from './pending-row-store';
import { with_pending_column_widths } from './column-structure-model';
import {
    has_inserted_or_moved_rows,
    INSERTED_ROWS_TRANSFORM_MESSAGE,
    rule_split_warning_message,
    rule_split_warnings,
} from './row-structure-model';

/**
 * Structural conflicts about a whole worksheet rather than a row or cell:
 * they carry no row identities, and the layout-conflict notice answers them with a
 * worksheet action ("Discard row and column changes on <sheet>"). An
 * `unsupportedStructure` refusal names its reason in `message` instead.
 */
const WORKSHEET_LEVEL_STRUCTURAL_CONFLICTS: ReadonlySet<string> = new Set([
    'structuralBasisChanged',
    'unsupportedStructure',
]);
import { column_letter } from './grid-model';
import {
    clamp_row_height,
    mapped_row_height_overlays,
    retained_row_height_overlay,
    row_height_layers_after_answer,
    row_height_layers_for_delivery,
    row_height_layers_with,
    row_height_order_marker,
    type RowHeightLayer,
    type RowHeightOverlay,
} from './row-heights';
import {
    create_column_projection,
    hide_all_columns,
    hide_source_columns,
    hidden_source_columns,
    sanitize_column_visibility_state,
    visibility_from_hidden_columns,
    show_all_columns,
    toggle_source_column,
} from './column-projection';
import { use_state_sync } from './use-state-sync';
import {
    host_bridge,
    install_pending_edit_flush_responder,
    pending_edit_durability,
    pending_changes_durability,
    publication_fence,
} from './host-bridge';
import { apply_font_family, apply_font_size } from './vscode-theme';
import {
    edit_command_target,
    history_hotkey_command,
    run_native_text_history,
    text_field_selection,
    type EditCommand,
} from './edit-command';
import { FindBar, type FindBarHandle, type FindStatus } from './find-bar';
import { is_find_hotkey, type FindDirection } from './find-model';
import './styles.css';

type ColumnVisibilityUpdater = (
    current: SheetColumnVisibilityState | undefined,
    column_count: number,
    schema: string,
) => SheetColumnVisibilityState | undefined;

/**
 * Where a transform request came from. `'history'` is a view step's replay:
 * it restores grid focus like `'grid'`, records nothing, and moves its entry
 * when it installs.
 */
type TransformOrigin = 'grid' | 'toolbar' | 'restore' | 'history';

/** What a press is told when the window gate needs a reopen or a reload. */
function terminal_gate_message(
    gate: Extract<HistoryPressGate, { kind: 'reload-required' | 'reopen-required' }>,
): string {
    return gate.kind === 'reopen-required'
        ? REOPEN_REQUIRED_MESSAGE
        : 'Reload this window to finish the header row change, then edit.';
}

/** What a gesture admission may leave out. */
interface GestureAdmissionOptions {
    /** The reopen fence: only for releasing an idle session. */
    readonly ignore_reopen?: boolean;
    /** A replay still waiting for this window's transforms: only for Cancel. */
    readonly replay_waiting_may_pass?: boolean;
}

/** A view step's replay in flight: the entry it moves when the host answers. */
interface ViewReplay {
    readonly entry: HistoryEntry;
    readonly direction: HistoryDirection;
    /** Why parts of the step were left out, for the message once it lands. */
    readonly skipped: readonly ViewSkipReason[];
    /**
     * The press this replay carries out, and how many snapshots the window
     * had applied when its request was posted. A replay the host refused
     * because a refresh was in transit is tried again for the same press,
     * once a snapshot applied since then says the refresh has arrived.
     */
    readonly press: HistoryPress;
    readonly posted_after: number;
}

/**
 * A press of Undo or Redo that is waiting: for something this window started
 * to clear (`wait`), for what a view step's own replay found in its way
 * (`step_wait`), or for keys typed at a cell to reach their editor (`typing`).
 */
interface HeldPress {
    readonly press: HistoryPress;
    readonly wait: HistoryPressWait;
    /**
     * What `replay_view_step` found pending for the step it resolved: a
     * request on that worksheet (a saved view being re-installed), or no
     * snapshot identity yet. The drain does not attempt the press again
     * until it is gone.
     */
    readonly step_wait?: { readonly sheet: number } | 'identity';
    /** Held for typed keys, not for the window: reserves nothing. */
    readonly typing?: true;
}

/**
 * A press whose replay a refresh overtook, waiting to be tried again. In its
 * own slot, so a press made meanwhile is held behind it and never replaces it.
 */
interface RetryPress {
    readonly press: HistoryPress;
    /** The entry the refused replay was for. The retry runs only if it is still on top. */
    readonly entry: HistoryEntry;
    /** The count `awaits` names, as it was when the refused request was posted. */
    readonly posted_after: number;
    /**
     * What says the refresh it lost to has arrived. A view replay: a snapshot
     * this window applied since its post (`applied_snapshot_seq_ref`). A cell
     * or structural replay: any delivery this window acknowledged since its
     * preparation was posted (`snapshot_applied_seq_ref`), applied or not, and
     * it waits for one within the bound. The host refused it because its view
     * had moved past what this window had acknowledged, so a delivery is on
     * its way; the refusal can arrive first (a refresh that cancelled the
     * lease is still building its snapshot), and a delivery this window
     * acknowledges without applying (stale or a duplicate) makes the host's
     * view current again all the same.
     */
    readonly awaits: 'applied' | 'delivery';
    readonly step_wait?: { readonly sheet: number } | 'identity';
}

/**
 * A sort, filter, or hide of this window awaiting `transformInstalled`: a
 * gesture, which records its step when it installs, or a replay, which moves
 * its entry. A restore and a cancel are neither and hold no record.
 */
interface PendingViewTransform {
    readonly requestId: string;
    /** The worksheet by identity: a reload can reorder or remove sheets. */
    readonly worksheet: WorksheetTarget;
    /**
     * The worksheet's columns when the request was composed. Its step names
     * columns as they were then, and a reload that overtakes the request can
     * bring other columns.
     */
    readonly schema: string;
    /** The rules this window held for the sheet when the request was composed. */
    readonly baseline: SheetTransformState | undefined;
    /** The rules requested. Absent for Hide rows: only the host knows its source rows. */
    readonly target?: SheetTransformState;
    readonly replay?: ViewReplay & { readonly delta: TransformViewDelta };
}

/** The window's view action, with what its step needs that the model does not keep. */
interface PendingViewAction {
    readonly action: ViewAction;
    readonly worksheet: WorksheetTarget;
    readonly schema: string;
    /** The baseline when the action began; it moves only for a change made elsewhere. */
    readonly initialBaseline: SheetTransformState | undefined;
    /** The newest request was refused. */
    readonly refused: boolean;
}

/** The one column visibility write awaiting `columnVisibilityChanged`. */
interface PendingColumnWrite {
    readonly requestId: string;
    readonly worksheet: WorksheetTarget;
    /** The worksheet's columns when the write was posted; see `PendingViewTransform.schema`. */
    readonly schema: string;
    readonly sourceGeneration: number;
    readonly before: SheetColumnVisibilityState | undefined;
    readonly after: SheetColumnVisibilityState | undefined;
    readonly replay?: ViewReplay;
    /** A snapshot has adopted column visibility since the write was posted. */
    snapshotAdopted: boolean;
}

/** One worksheet of a column-width write awaiting `columnWidthsChanged`. */
interface PendingWidthSheet {
    readonly worksheet: WorksheetTarget;
    /** What the window showed for each column it asked to change, to put back on a refusal. */
    readonly shown: readonly { readonly column: number; readonly width: number | null }[];
    /**
     * The sheet's whole width map as the window showed it right after the
     * post. If a snapshot was adopted while the write was pending and the
     * widths are no longer this, something else wrote them and Auto-fit ends.
     */
    readonly posted: Readonly<Record<number, number>> | undefined;
    /** Auto-fit for the sheet before the write, put back on a refusal. */
    readonly autoFitBefore: {
        readonly active: boolean;
        readonly snapshot: Record<number, number> | undefined;
    };
    /** What the gesture did to Auto-fit, for its step. */
    readonly autoFit?: AutoFitChange;
    /**
     * The widths the gesture replaced on the sheet's Pending Columns, by
     * column ID. Auto-fit on and off size them with the saved columns, in the
     * Pending Changes and at once; a refusal puts these back.
     */
    readonly pendingColumnWidthsBefore?: Readonly<Record<string, number | undefined>>;
}

/**
 * What Auto-fit keeps beside the widths and the toolbar: the worksheets still
 * owed a fit, and each worksheet's Pending Column widths from before its fit.
 */
interface AutoFitExtras {
    readonly owed: ReadonlySet<number>;
    readonly pendingColumnSnapshots: readonly (Record<string, number | undefined> | undefined)[];
}

/**
 * The one column-width write awaiting `columnWidthsChanged`: a resize, a fit,
 * a restore, or a width step's replay.
 */
interface PendingWidthWrite {
    readonly requestId: string;
    readonly sourceGeneration: number;
    readonly sheets: readonly PendingWidthSheet[];
    readonly replay?: ViewReplay;
    /**
     * What the gesture or replay dropped of Auto-fit's own state on its way
     * to the write, as it was before: put back with the widths if the host
     * refuses.
     */
    readonly autoFitExtrasBefore?: AutoFitExtras;
    /**
     * A fit owed to a worksheet, applied when it could be: nobody pressed
     * anything, so a refusal says nothing and the fit stays owed.
     */
    readonly owed: boolean;
    /** A snapshot has adopted column widths since the write was posted. */
    snapshotAdopted: boolean;
}

/** A row-height request awaiting `rowHeightsChanged`. */
interface PendingRowResize {
    readonly sourceGeneration: number;
    /** The worksheet by identity: its step is recorded for it, wherever it sits by then. */
    readonly worksheet: WorksheetTarget | undefined;
    /** A resize or reset the person made, which records a step when it lands. */
    readonly gesture: boolean;
    /** A row-height step's replay, which moves its entry when it lands. */
    readonly replay?: ViewReplay;
    /** The Pending Rows half of a mixed resize, committed or dropped with the answer. */
    readonly finish?: (applied: boolean) => void;
}

/** How a column-width write ended. */
type WidthWriteOutcome =
    /** The durable state holds it; `change` is what the host says the write changed. */
    | { readonly kind: 'applied'; readonly change: readonly ColumnWidthsSheetChange[] }
    /** Nothing was written. `unresolved`: a structural save the person has not resolved. */
    | { readonly kind: 'refused'; readonly unresolved: boolean }
    /** A refresh of another source arrived first; the write's own answer no longer matches. */
    | { readonly kind: 'overtaken' };

/** One worksheet of a column-width write to post. */
interface WidthWriteSheet {
    readonly sheet_index: number;
    /**
     * The widths to ask the host for. None, on a sheet whose Auto-fit and
     * Pending Columns change with the other sheets of the write: the host is
     * not asked about it, and a refusal puts it back with them.
     */
    readonly widths: readonly { readonly column: number; readonly width: number | null }[];
    /** Auto-fit for the sheet from the post on: on with the widths to restore, or off. */
    readonly auto_fit:
        | { readonly active: true; readonly snapshot: Record<number, number> | undefined }
        | { readonly active: false };
    /** What the gesture did to Auto-fit, for its step. */
    readonly auto_fit_change?: AutoFitChange;
    /** The Pending Column widths the caller has just replaced: see `PendingWidthSheet`. */
    readonly pending_column_widths_before?: Readonly<Record<string, number | undefined>>;
}

/** Whether an action is a column-width or row-height step. */
function action_is_size_step(action: HistoryEntry['action']): boolean {
    return action.changes.length > 0 && action.changes.every((change) =>
        change.kind === 'view'
        && (change.delta.slice === 'columnWidths' || change.delta.slice === 'rowHeights'));
}

/**
 * A sheet the header queue still owes a change, by identity: a refresh while
 * the request waits can reorder the workbook, and an index would then name
 * another worksheet.
 */
interface ExcelHeaderQueueSheet {
    readonly name: string;
    readonly worksheet_id?: string;
    /**
     * A header step's replay: the header state to install on this sheet, by
     * source row. A gesture's request is the queue's own, the same for every
     * sheet; a replay's differs sheet by sheet.
     */
    readonly target?: ExcelHeaderTarget;
}

function excel_header_queue_sheet(
    sheet: { readonly name: string; readonly worksheetId?: string },
    target?: ExcelHeaderTarget,
): ExcelHeaderQueueSheet {
    return {
        name: sheet.name,
        ...(sheet.worksheetId === undefined ? {} : { worksheet_id: sheet.worksheetId }),
        ...(target === undefined ? {} : { target }),
    };
}

/**
 * One run of the header queue, from the gesture or the Undo that started it
 * to its end: what becomes one step in history, or the one step a replay
 * moves.
 *
 * A mutable object in a ref of its own, not a field of the queue: the queue
 * is replaced by a spread at every step and the request in flight keeps an
 * old one, while what the run collects has to survive all of that.
 */
interface HeaderRun {
    /** A header step's replay; absent for a gesture. */
    readonly replay?: ViewReplay;
    /** The worksheet a replay's messages name. */
    readonly worksheet?: WorksheetTarget;
    /** What the host says each settled request changed, one per worksheet. */
    readonly changes: HeaderViewDelta[];
    /** Replay only: how many of its requests the host committed. */
    landed: number;
    /** Replay only: skip reasons, the ones found while the run was under way included. */
    readonly skipped: Set<ViewSkipReason>;
    /**
     * Replay only: why a posted sheet did not land. `silent`: the person is
     * told by what the queue already says (a result that needs a reload).
     */
    failed?:
        | { readonly reason: string }
        | { readonly wait: ViewReplayWait }
        | { readonly silent: true };
}

/** Where the queued sheet is now, or -1 once it is gone. */
function excel_header_queue_sheet_index(
    sheets: readonly { readonly name: string; readonly worksheetId?: string }[],
    target: ExcelHeaderQueueSheet,
): number {
    return sheets.findIndex((sheet) => (
        target.worksheet_id !== undefined && sheet.worksheetId !== undefined
            ? sheet.worksheetId === target.worksheet_id
            : sheet.name === target.name
    ));
}

/** What starts the header queue: a gesture's request, or a header step's replay. */
interface HeaderQueueRequest {
    readonly enabled: boolean;
    readonly unhide_all?: boolean;
    readonly header_row?: number;
    readonly sheets: readonly number[];
    readonly grid_focus_sheet_index?: number;
    /** A replay: the target of each sheet in `sheets`, and the entry it moves. */
    readonly targets?: ReadonlyMap<number, ExcelHeaderTarget>;
    readonly replay?: ViewReplay;
    readonly worksheet?: WorksheetTarget;
}

/** Header Row changes still owed, one sheet per host request. See `drain_excel_header_queue`. */
interface ExcelHeaderQueue {
    readonly enabled: boolean;
    readonly unhide_all: boolean;
    /** The host display row to promote; display-keyed, so bound to `generation`. */
    readonly header_row?: number;
    readonly sheets: readonly ExcelHeaderQueueSheet[];
    readonly grid_focus_sheet?: ExcelHeaderQueueSheet;
    readonly generation: number;
    readonly retries: number;
    /** A transient rejection waits for a snapshot applied after this count... */
    readonly retry_after_snapshot?: number;
    /** ...or for this time, whichever comes first. */
    readonly retry_not_before?: number;
    /**
     * The header fence is up for this request. It goes up only once work
     * admitted before the request (an append or insert awaiting its host
     * admission, a replay, a highlight, a resize, a discard, a save) has
     * finished into its stores: raising it earlier would cancel that work.
     */
    readonly fenced: boolean;
    /** Every store was published for this request. */
    readonly flushed: boolean;
    readonly ack_wait_started?: number;
    /** Set for a header step's replay: what the disabled controls say meanwhile. */
    readonly replay?: HistoryDirection;
    /**
     * The gesture's ticket (`gesture_ticket`), taken when it was queued. The
     * drain's fold of the open editor shows it at the edit gate: a press of
     * Undo or Redo made after the gesture is held behind it, and must not
     * refuse the fold that the gesture was asked for before it.
     */
    readonly ticket: number;
}

/** How long a header change waits for the host to acknowledge the session's publications. */
const HEADER_ACK_WAIT_MS = 15_000;
/** After this long without a result, the person is told to reload. */
const HEADER_RESULT_GUARD_MS = 60_000;
const HEADER_RETRY_DELAY_MS = 250;
/** How soon a header change waiting on typed keys looks again. */
const HEADER_TYPING_WAKE_MS = 50;
const HEADER_TRANSIENT_RETRIES = 3;
type FilterHistogramState = FilterHistogramStatus;

const GRID_FOCUS_RESTORE_MAX_ATTEMPTS = 8;
/**
 * How long the Save warnings' formula question waits after the layouts or
 * edits last changed, so a burst of gestures (a held move shortcut) asks once.
 */
const FORMULA_REVIEW_DELAY_MS = 150;
const EMPTY_CONFLICTS: readonly PendingStructuralConflict[] = Object.freeze([]);
const GRID_FOCUS_RESTORE_RETRY_MS = 16;
const EXTERNAL_CHANGE_FORMATTING_COMPARISON_BUDGET = 1_000_000;

function review_value(value: string): string {
    return value === '' ? '(empty)' : value;
}

function review_link(link: CellHyperlink | null): string {
    if (link === null) return 'No link';
    const destination = link.kind === 'external'
        ? `External link: ${link.target}`
        : `Workbook link: ${link.location}`;
    return link.tooltip ? `${destination} (tooltip: ${link.tooltip})` : destination;
}

function review_formatting_changed(
    before_value: string,
    before: RichText | undefined,
    after_value: string,
    after: RichText | undefined,
    budget: { remaining: number },
): boolean {
    const before_rich = before ?? rich_text_from_plain(before_value);
    const after_rich = after ?? rich_text_from_plain(after_value);
    if (!rich_text_has_styles(before_rich) && !rich_text_has_styles(after_rich)) {
        return false;
    }
    const cost = before_value === after_value
        ? Math.max(before_value.length, after_value.length)
        : before_value.length * after_value.length;
    // One review can contain many medium-sized cells. Bound their TOTAL work,
    // not only each comparison: uncertainty omits an informational note rather
    // than freezing the panel or falsely claiming formatting changed.
    if (!Number.isSafeInteger(cost) || cost > budget.remaining) return false;
    budget.remaining -= cost;
    return !rich_text_formatting_equal(
        before_rich,
        after_rich,
    );
}

/** Canonical identity for one observed file side. Unknown extra wire fields are
 * deliberately ignored, and equivalent plain-run/link encodings agree. */
function external_change_observation_signature(
    observed: CsvObservedFileBase | undefined,
): string {
    if (observed === undefined) return 'unavailable';
    const normalized = observed.runs === undefined
        ? undefined
        : normalize_rich_text(observed.runs);
    const effective_runs = normalized !== undefined && rich_text_has_styles(normalized)
        ? normalized.runs.map((run) => (
            [
                run.text,
                run.style?.bold === true,
                run.style?.italic === true,
                run.style?.underline === true,
                run.style?.strikethrough === true,
            ] as const
        ))
        : null;
    const link = observed.link === undefined
        ? ['absent'] as const
        : observed.link === null
            ? ['set', null] as const
            : observed.link.kind === 'external'
                ? ['set', 'external', observed.link.target, observed.link.tooltip ?? ''] as const
                : ['set', 'internal', observed.link.location, observed.link.tooltip ?? ''] as const;
    return JSON.stringify([observed.value, effective_runs, link]);
}

function review_formatting(value: string, formatting: RichText | undefined): string {
    const rich = formatting ?? rich_text_from_plain(value);
    if (rich.runs.length === 0) return 'Plain';
    return rich.runs.map((run) => {
        const styles = [
            ...(run.style?.bold ? ['bold'] : []),
            ...(run.style?.italic ? ['italic'] : []),
            ...(run.style?.underline ? ['underline'] : []),
            ...(run.style?.strikethrough ? ['strikethrough'] : []),
        ];
        const label = styles.length > 0 ? styles.join(', ') : 'plain';
        return `${label}: ${review_value(run.text)}`;
    }).join('; ');
}

/** Whether a live control currently owns focus (as opposed to a remount leaving it on body). */
function has_surviving_focus_target(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement
        && active !== document.body
        && active !== document.documentElement
        && active.isConnected;
}

interface GridFocusRestoreState {
    sheet_index: number;
    generation: number;
    document_epoch: number;
    /** Focus the toolbar when the grid, once mounted, has nothing to focus. */
    or_toolbar?: true;
}

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

export { transforms_semantically_equal };

/**
 * The durable rules to reconcile against, with the compare window's session
 * filter carried over from the installed view.
 *
 * "Only changed rows" is session state: the host strips it at the durable
 * write, so it is never in the record read back here. Without carrying it over,
 * every reconciliation — including the one the filter's own install triggers —
 * read the durable record as "no filter" and immediately asked for the filter
 * to be turned back off. That is what made the toggle flash the worksheet and
 * change nothing.
 */
export function reconciliation_intent(
    durable: SheetTransformState | undefined,
    installed: SheetViewRecord | undefined,
    schema: string,
): SheetTransformState | undefined {
    const only_changed_rows = installed?.permuted === true
        && installed.rules.onlyChangedRows === true;
    if (!only_changed_rows) return durable;
    return {
        ...(durable ?? { ...EMPTY_TRANSFORM, schema }),
        onlyChangedRows: true,
    };
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

function ExternalChangeItem({
    source_key,
    on_detach,
    children,
}: {
    source_key: string;
    on_detach: (source_key: string, element: HTMLLIElement) => void;
    children: React.ReactNode;
}): React.JSX.Element {
    const element_ref = useRef<HTMLLIElement | null>(null);
    const mount = useCallback((element: HTMLLIElement | null) => {
        const previous = element_ref.current;
        element_ref.current = element;
        if (element === null && previous !== null) on_detach(source_key, previous);
    }, [on_detach, source_key]);
    return (
        <li className="external-change-item" ref={mount}>
            {children}
        </li>
    );
}

/** Webview root for snapshot metadata plus paginated row delivery. */
/** A cursor on a source cell, by worksheet and source coordinates. */
interface SourceCellFocus {
    readonly sheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
}

/** JSON equality that ignores object key order (arrays keep theirs). */
function same_json(left: unknown, right: unknown): boolean {
    const canonical = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value === null || typeof value !== 'object') return value;
        return Object.fromEntries(Object.keys(value).sort()
            .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    };
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** A worksheet's body start and size as `meta` has them, for history. */
function history_header_sheet(
    meta: WorkbookMeta | null,
    worksheet: WorksheetTarget,
): HeaderSheet | undefined {
    const sheets = meta?.sheets;
    if (sheets === undefined) return undefined;
    const index = worksheet_target_index(sheets, worksheet);
    const sheet = index === undefined ? undefined : sheets[index];
    return sheet === undefined
        ? undefined
        : {
            bodyStart: header_body_start(sheet.excelFirstRowHeader),
            sourceRowCount: sheet.sourceRowCount,
        };
}

/**
 * How a committed replay landed in this window: stores and history together;
 * not at all because no session holds the stores now; or not at all because
 * this view cannot follow the file.
 */
type ReplayLanding = 'applied' | 'unstaged' | 'diverged';

export function App(): React.JSX.Element {
    const [meta, set_meta] = useState<WorkbookMeta | null>(null);
    const [generation, set_generation] = useState(0);
    // After the commit that renders it, for the latency spec.
    useEffect(() => { perf_mark('tv:view-generation-rendered', { generation }); }, [generation]);
    // Bumped on every initial snapshot (a fresh document load — including the
    // preview pane reusing its panel for a different file). Folded into the GridShell key
    // so the row loader remounts clean; a new file can otherwise collide with the
    // previous one's generation (both start at 1) and surface stale cached pages.
    const [load_epoch, set_load_epoch] = useState(0);
    // Most generation changes replace the grid because transforms and external
    // reloads can change row identity under selection and open UI. A successful
    // save over a natural view only replaces the backing pages, so keep that
    // grid mounted and let the generation-aware row loader refresh its cache in
    // place. A transformed view still remounts because source adoption replaces
    // its display-row mapping before the transform is restored.
    const [grid_mount_epoch, set_grid_mount_epoch] = useState(0);
    // Counts the grids mounted: one per active sheet and mount epoch. A
    // gesture that waited compares it, to know its grid is still the one
    // shown (a sheet left and returned to is a new grid).
    const grid_instance_ref = useRef(0);
    const [active_sheet_index, set_active_sheet_index] = useState(0);
    // Read when a save captures the cursor, from callbacks that may be stale.
    const active_sheet_index_for_focus_ref = useRef(0);
    active_sheet_index_for_focus_ref.current = active_sheet_index;
    // The sheet React has selected, kept separate from the host-authored
    // activeSheetIndex in state_ref. A refresh can clamp the rendered index
    // while the durable host value still names a removed sheet.
    const rendered_sheet_index_ref = useRef(0);
    useLayoutEffect(() => {
        rendered_sheet_index_ref.current = active_sheet_index;
    }, [active_sheet_index]);
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
    /**
     * Give a row-height request that paints nothing (a reset, an undo or redo)
     * its place among the heights painted on its worksheet, so that its
     * applied answer retires the ones painted before it. With none painted
     * there is nothing to come after.
     */
    const mark_row_height_request = useCallback((sheet_index: number, request_id: string) => {
        set_row_height_overlay((previous) => {
            const existing = previous[sheet_index];
            if (existing === undefined) return previous;
            const next = [...previous];
            next[sheet_index] = {
                ...existing,
                layers: row_height_layers_with(existing.layers, row_height_order_marker(request_id)),
            };
            return next;
        });
    }, []);
    const [auto_fit_active, set_auto_fit_active] = useState<boolean[]>([]);
    /**
     * Whether history has something to redo, and how many snapshots have been
     * applied: what a fit still owed to a worksheet waits on, read into state
     * so the retry runs again when either moves.
     */
    const [redo_available, set_redo_available] = useState(false);
    const [applied_snapshot_count, set_applied_snapshot_count] = useState(0);
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
    // Keep live pixel offsets above GridShell's remount boundary so transforms,
    // external reloads, and worksheet switches preserve the user's place.
    const grid_scroll_positions_ref = useRef<Map<string, ScrollPosition>>(new Map());
    const [csv_editable, set_csv_editable] = useState(false);
    const [csv_editing_supported, set_csv_editing_supported] = useState(false);
    // 'markdown' on xlsx: cell text edits as inline markup (see cell-edit-model).
    const [edit_syntax, set_edit_syntax] = useState<'plain' | 'markdown'>('plain');
    // The source's append row ceiling, resolved host-side by
    // `append_row_ceiling_for`. `null` on the wire means "no ceiling" and is
    // widened to Infinity here; absent means an older host, which reads as the
    // worksheet ceiling every format used to be checked against.
    const [append_row_ceiling, set_append_row_ceiling] = useState(MAX_SHEET_ROWS);
    // Row and column structure support per worksheet; undefined while the host
    // has structural editing off, which hides every structure item.
    const [structural_editing, set_structural_editing] =
        useState<StructuralEditingCapability>();
    const [csv_edit_session_id, set_csv_edit_session_id_state] = useState<string>();
    const csv_edit_session_id_ref = useRef<string>();
    const append_composer_drafts_ref = useRef<Map<
        string,
        { sessionId: string; schema: string; draft: AppendComposerDraft }
    >>(new Map());
    const [, set_append_composer_draft_revision] = useState(0);
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
    /**
     * This window said it no longer matches its file ("…Reopen the file to
     * resynchronize."). Until a new document replaces every store it takes no
     * recorded change, and `publication_fence` keeps its stores from the host.
     * The state copy pauses the grid's editing in the same render.
     */
    const reopen_required_ref = useRef(false);
    const [reopen_required, set_reopen_required] = useState(false);
    // Declared with the header queue's drain, further down.
    const wake_header_drain_ref = useRef<() => void>(() => {});
    // `refused_for_reopen`, for the callbacks declared before it.
    const refused_for_reopen_ref = useRef<() => boolean>(() => false);
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
    // Every Pending Change this render reads, and what is derived from them.
    // Subscribing here re-renders App whenever the registry publishes.
    const pending_snapshot = use_pending_snapshot(
        edit_session_registry_ref.current,
        meta?.sheets,
        edit_syntax === 'markdown',
    );
    const { structure: pending_structure, cells: pending_cells } = pending_snapshot;
    const formula_roots_projection = edit_session_registry_ref.current.formula_projection(
        meta?.sheets.map((sheet) => sheet.sourceRowCount),
    );
    const value_edit_order_floor = edit_session_registry_ref.current.value_edit_order_floor();
    const formula_header_coordinate_signature = JSON.stringify((meta?.sheets ?? []).map(
        (sheet) => [
            sheet.excelFirstRowHeader?.active === true,
            sheet.excelFirstRowHeader?.sourceRow ?? 0,
        ],
    ));
    // The workbook every formula renders against: each worksheet's layout and
    // append band.
    const formula_anchor_workbook = meta ? pending_structure.formula_workbook() : undefined;
    const structural_formula_state = useMemo(() => {
        const edits: FormulaCalculationEdit[] = formula_roots_projection.edits.map((edit) => {
            const sheet = meta?.sheets[edit.sheetIndex];
            const header_row = sheet?.excelFirstRowHeader?.sourceRow ?? 0;
            return sheet?.excelFirstRowHeader?.active === true && edit.row === header_row
                ? { ...edit, writesFormula: false }
                : edit;
        });
        const { changes_for } = pending_structure;
        // A pending cut move retargets formulas only on the move path, which
        // calculates nothing live; the two are never combined.
        if (formula_roots_projection.moves.length === 0
            && formula_anchor_workbook !== undefined
            && needs_prospective_formula_request(
            formula_anchor_workbook,
            edits,
            formula_roots_projection.pendingEdits,
            changes_for,
        )) {
            // Every address is prospective: formulas render from their anchors
            // for the current layouts, and every formula is recalculated.
            const request = prospective_formula_request({
                workbook: formula_anchor_workbook,
                changes_for,
                edits,
                pending_edits: formula_roots_projection.pendingEdits,
            });
            return {
                edits: request.edits,
                sourceEdits: edits,
                prospectiveRowCounts: request.prospectiveRowCounts,
                removedRows: [],
                prospective: {
                    workbook: formula_anchor_workbook,
                    layouts: request.layouts,
                    editTargets: request.editTargets,
                    graphRoots: request.graphRoots,
                },
                tooManyEdits: formula_roots_projection.tooManyEdits || request.tooMany,
            };
        }
        const prospectiveRowCounts = (meta?.sheets ?? []).map((sheet, sheetIndex) => {
            const changes = changes_for(sheetIndex) ?? EMPTY_PENDING_STRUCTURAL_CHANGES;
            const prospective_start = sheet.sourceRowCount - changes.tailRemovals.length;
            return prospective_start + pending_rows(changes).length;
        });
        for (const edit of formula_roots_projection.pendingEdits) {
            const sheet = meta?.sheets[edit.sheetIndex];
            if (sheet === undefined || edit.column >= sheet.columnCount) continue;
            const changes = changes_for(edit.sheetIndex) ?? EMPTY_PENDING_STRUCTURAL_CHANGES;
            edits.push({
                sheetIndex: edit.sheetIndex,
                row: sheet.sourceRowCount - changes.tailRemovals.length
                    + edit.pendingRowIndex,
                column: edit.column,
                value: edit.value,
                writesFormula: edit.writesFormula,
                ...(edit.runs !== undefined ? { runs: edit.runs } : {}),
            });
        }
        const removedRows = [...pending_structure.by_sheet].flatMap(([sheetIndex, changes]) =>
            changes.tailRemovals.map(({ sourceRow }) => ({ sheetIndex, row: sourceRow })));
        edits.sort((left, right) => (left.sheetIndex - right.sheetIndex)
            || (left.row - right.row)
            || (left.column - right.column));
        return {
            edits,
            sourceEdits: edits,
            prospectiveRowCounts,
            removedRows,
            prospective: undefined,
            tooManyEdits: formula_roots_projection.tooManyEdits
                || edits.length > MAX_WORKBOOK_FORMULAS,
        };
    },
        // The projection's revisions stand in for its edit arrays.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [
            pending_structure,
            formula_roots_projection.structuralRevision,
            formula_roots_projection.calculationRevision,
            formula_header_coordinate_signature,
            formula_anchor_workbook,
            meta,
        ],
    );
    /** Layouts and every formula target when addresses are prospective; see `prospective_formula_request`. */
    const prospective_formula_state = structural_formula_state.prospective;
    const formula_calculation_edits = structural_formula_state.edits;
    const prospective_formula_row_counts = structural_formula_state.prospectiveRowCounts;
    const removed_formula_rows = structural_formula_state.removedRows;
    // Cell edits at their source coordinates: what a source request, and every
    // consumer that reads source column names, needs even when the calculation
    // request itself is prospective.
    const source_formula_edits = structural_formula_state.sourceEdits;
    const header_calculation_edits = useMemo(() => source_formula_edits.filter((edit) => {
        const sheet = meta?.sheets[edit.sheetIndex];
        return sheet?.excelFirstRowHeader?.active === true
            && edit.row === (sheet.excelFirstRowHeader.sourceRow ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [source_formula_edits, formula_header_coordinate_signature]);
    const formula_roots = formula_calculation_edits;
    const formula_root_signature = structural_formula_state.tooManyEdits
        ? 'too-many-edits'
        : `${formula_roots_projection.coordinateRevision}:`
            + `${formula_roots_projection.structuralRevision}`;
    const formula_calculation_edit_signature
        = `${formula_roots_projection.calculationRevision}:`
            + `${formula_roots_projection.structuralRevision}`;
    const formula_moves = formula_roots_projection.moves;
    const has_formula_moves = formula_moves.length > 0;
    const formula_sheet_names = (meta?.sheets ?? []).map((sheet) => sheet.name);
    const formula_sheet_name_signature = JSON.stringify(formula_sheet_names);
    const formula_move_signature = formula_moves.map((move) => [
        move.order ?? 0,
        move.sheetIndex,
        move.sourceRow,
        move.sourceColumn,
        move.destinationRow,
        move.destinationColumn,
    ].join(':')).join(';');
    const structured_column_renames = source_formula_edits.flatMap((edit) => {
        const sheet = meta?.sheets[edit.sheetIndex];
        const header_row = sheet?.excelFirstRowHeader?.sourceRow ?? 0;
        const old_name = sheet?.columnNames?.[edit.column];
        if (
            sheet?.excelFirstRowHeader?.active !== true
            || edit.row !== header_row
            || edit.writesFormula
            || old_name === undefined
            || sheet.columnNames?.filter((name) => name.localeCompare(
                old_name, undefined, { sensitivity: 'accent' },
            ) === 0).length !== 1
        ) return [];
        const new_name = committed_column_name(edit.value);
        if (new_name === '' || new_name.localeCompare(
            old_name, undefined, { sensitivity: 'accent' },
        ) === 0) return [];
        return [{ sheetIndex: edit.sheetIndex, oldName: old_name, newName: new_name }];
    });
    const structured_column_rename_signature = JSON.stringify(structured_column_renames);
    const formula_move_retargeter = useMemo(
        () => {
            const retarget_a1 = compile_a1_formula_move_retargeter(
                formula_sheet_names,
                formula_moves,
            );
            return (formula: string, formulaSheetIndex: number, afterOrder?: number) =>
                retarget_renamed_structured_formula(
                    retarget_a1(formula, formulaSheetIndex, afterOrder),
                    formulaSheetIndex,
                    formula_sheet_names,
                    structured_column_renames,
                );
        },
        // The signatures name provenance and sheet qualifiers independently of
        // formula value edits and the arrays allocated by this render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [
            load_epoch,
            formula_move_signature,
            formula_sheet_name_signature,
            structured_column_rename_signature,
        ],
    );
    const too_many_formula_calculation_edits = structural_formula_state.tooManyEdits;
    // Whether this panel holds the workbook's editing session. Nobody enters or
    // leaves it: the first editing gesture acquires it, and it is released once
    // it holds nothing. One granted session makes every worksheet editable; the
    // active tab chooses only which per-sheet store the mounted grid views.
    const [editing_session_held, set_editing_session_held_state] = useState(false);
    // Diff toggle (before/after view of dirty cells). Deliberately never reset
    // when a session ends: the button hides when nothing is unsaved, but the
    // choice is still there the next time something is.
    const [diff_mode, set_diff_mode] = useState(false);
    const diff_mode_initialized_ref = useRef(false);
    const diff_on_by_default_ref = useRef(false);
    const handle_toggle_diff_mode = useCallback(() => set_diff_mode((d) => !d), []);
    // Git compare session (SCM diff click): per-cell diff highlighting against
    // the git original, read-only. Snapshot-delivered like the capabilities.
    const [git_compare, set_git_compare] =
        useState<WorkbookSnapshotCompare | undefined>(undefined);
    // A side of this panel is an unfetched Git LFS object. Snapshot-delivered
    // beside `git_compare` because it is the same kind of fact: host-owned
    // state about what this panel is showing, not about the grid's contents.
    const [unresolved_lfs, set_unresolved_lfs] =
        useState<UnresolvedLfsObject | undefined>(undefined);
    // A resolve is in flight. Local rather than snapshot-delivered: the host
    // sends no message while the download runs, and the button has to reflect
    // the click immediately. Cleared only by the `lfsResolveEnded` that
    // matches the pending request — NOT by snapshots, which describe what the
    // panel shows rather than acknowledging actions. What the resolve
    // produced (the real table, or the pointer again with a failure) still
    // arrives by snapshot; this flag only says whether the host is still
    // working on it.
    const [lfs_resolving, set_lfs_resolving] = useState(false);
    const lfs_resolve_request_seq_ref = useRef(0);
    const lfs_resolve_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    // The one resolve this renderer is waiting on. A ref rather than state:
    // the click handler needs a synchronous duplicate-click fence, and the
    // ending handler needs the id without re-rendering on it.
    const pending_lfs_resolve_request_ref = useRef<string | null>(null);
    // Row alignment runs before the workbook snapshot exists, so this is the
    // only thing the compare window has to show meanwhile. Its arrival is what
    // tells the renderer a comparison is being aligned at all.
    const [compare_progress, set_compare_progress] =
        useState<{ scannedRows: number; totalRows: number } | undefined>(undefined);
    const editing_session_held_ref = useRef(false);
    // Passed down as the admission lifetime instead of asking GridShell to derive
    // one during render. React can abandon a child render; only these parent-owned
    // state updates make a new activation observable to the mounted tree.
    const [edit_activation_id, set_edit_activation_id] = useState(0);
    const advance_edit_activation = useCallback(() => {
        set_edit_activation_id((current) => current + 1);
    }, []);
    const set_editing_session_held = useCallback((next: boolean) => {
        const previous = editing_session_held_ref.current;
        editing_session_held_ref.current = next;
        // Leaving is a new activation too. The grid fences the one that ended,
        // and with no mode to re-enter nothing else would lift that fence: the
        // next editing gesture has to find cells that accept it.
        if (next !== previous) advance_edit_activation();
        set_editing_session_held_state(next);
    }, [advance_edit_activation]);
    /**
     * The workbook's undo history — one, for the whole workbook, because undoing
     * an edit made on another sheet switches to that sheet.
     *
     * A ref rather than state: capture reads the current stack synchronously
     * mid-gesture, with no re-render between reading it and recording into it,
     * and a wide paste must not rebuild App's callbacks while it is being
     * assembled. The object also has to survive a GridShell remount, which is
     * keyed by generation and by sheet.
     */
    const history_store_ref = useRef<HistoryStore | null>(null);
    if (history_store_ref.current === null) {
        history_store_ref.current = create_history_store(undefined, {
            // Read when a gesture is recorded, never during this render.
            body_start: (worksheet) => history_header_sheet(meta_ref.current, worksheet)?.bodyStart ?? 0,
        });
    }
    /**
     * Why the entry the last replay asked about cannot be replayed under the
     * current Header Row, for the warning. Written by `entry_for_replay`.
     */
    const header_wait_ref = useRef<HeaderWait | null>(null);
    /**
     * The entry as it reads under the current Header Row, for building a
     * replay; undefined, with the reason kept for the warning, when it has no
     * form under it. History always moves the stored entry.
     */
    const entry_for_replay = (entry: HistoryEntry): HistoryEntry | undefined => {
        const result = entry_for_current_header(
            entry,
            (worksheet) => history_header_sheet(meta_ref.current, worksheet),
        );
        if (result.ok) return result.entry;
        header_wait_ref.current = result;
        return undefined;
    };
    const entry_for_replay_ref = useRef(entry_for_replay);
    entry_for_replay_ref.current = entry_for_replay;

    /**
     * The layout-conflict notice's "Discard row and column changes on <sheet>": drop the
     * active worksheet's layout, as one history action, after the file changed
     * under it. Cell edits and appended rows stay and reconcile as usual.
     */
    /** The active-sheet context the salvage actions and their formula count run against. */
    const salvage_context = (sheet_index: number) => {
        const sheet = meta_ref.current?.sheets[sheet_index];
        if (sheet === undefined) return undefined;
        const header = sheet.excelFirstRowHeader;
        return {
            worksheet: {
                sheetIndex: sheet_index,
                sheetName: sheet.name,
                ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
            },
            bodyStart: header_body_start(header),
            sourceRowCount: sheet.sourceRowCount,
            sourceColumnCount: sheet.columnCount,
            bodyViewTransformed: false,
        };
    };
    const discard_active_layout_changes = useCallback(() => {
        const sheet_index = active_sheet_index;
        const sheet = meta_ref.current?.sheets[sheet_index];
        const session_id = csv_edit_session_id_ref.current;
        if (sheet === undefined || session_id === undefined) return;
        // A window that must be reopened changes no store.
        if (refused_for_reopen_ref.current()) return;
        // Admitted like every other edit gesture: not across a save, a
        // replay, an outstanding highlight, resize, or append.
        if (save_in_flight_ref.current || !edit_gestures_admitted()) return;
        const store = edit_session_registry_ref.current!.pending_rows_for_sheet(sheet_index);
        const before = store.snapshot();
        const header = sheet.excelFirstRowHeader;
        const result = discard_layout_changes(before, {
            worksheet: {
                sheetIndex: sheet_index,
                sheetName: sheet.name,
                ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
            },
            bodyStart: header_body_start(header),
            sourceRowCount: sheet.sourceRowCount,
            sourceColumnCount: sheet.columnCount,
            bodyViewTransformed: false,
        });
        if (!result.ok) {
            host_bridge.postMessage({ type: 'showWarning', message: result.refusal.message });
            return;
        }
        const staged_store = store.stage_replace(session_id, before, result.outcome.next);
        if (staged_store === undefined) return;
        const record = history_store_ref.current!.stage_record({
            label: `Discard row and column changes on ${sheet.name}`,
            changes: [result.outcome.change, ...(result.outcome.additionalChanges ?? [])],
        });
        commit_staged_transaction([record, staged_store]);
    }, [active_sheet_index]);

    /**
     * The layout-conflict notice's "Keep new rows at the end": every live Pending Inserted
     * Row on the active worksheet becomes a Pending Appended Row, in layout
     * order, and the rest of the layout is dropped, as one history action
     * whose Undo puts the rows back where they were.
     */
    const keep_active_inserted_rows_at_end = useCallback(() => {
        const sheet_index = active_sheet_index;
        const sheet = meta_ref.current?.sheets[sheet_index];
        const session_id = csv_edit_session_id_ref.current;
        if (sheet === undefined || session_id === undefined) return;
        if (refused_for_reopen_ref.current()) return;
        if (save_in_flight_ref.current || !edit_gestures_admitted()) return;
        const store = edit_session_registry_ref.current!.pending_rows_for_sheet(sheet_index);
        const before = store.snapshot();
        const header = sheet.excelFirstRowHeader;
        const result = keep_inserted_rows_at_end(before, {
            worksheet: {
                sheetIndex: sheet_index,
                sheetName: sheet.name,
                ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
            },
            bodyStart: header_body_start(header),
            sourceRowCount: sheet.sourceRowCount,
            sourceColumnCount: sheet.columnCount,
            bodyViewTransformed: false,
        // On the clock append orders use, so later appends still sort after these rows.
        }, Date.now() * 1_000);
        if (!result.ok) {
            host_bridge.postMessage({ type: 'showWarning', message: result.refusal.message });
            return;
        }
        const staged_store = store.stage_replace(session_id, before, result.outcome.next);
        if (staged_store === undefined) return;
        const record = history_store_ref.current!.stage_record({
            label: 'Keep new rows at the end',
            changes: [result.outcome.change, ...(result.outcome.additionalChanges ?? [])],
        });
        commit_staged_transaction([record, staged_store]);
    }, [active_sheet_index]);

    /**
     * Record a highlight gesture this window made, once the host has applied it.
     *
     * A plain record with nothing staged alongside it: unlike a cell edit, the
     * mutation has ALREADY happened on the host and in durable state by the time
     * this window sees it, so there is nothing left to hold back. A refusal
     * therefore cannot un-apply the gesture — it installs the barrier that makes a
     * later undo explain itself, which is the same trade the discard makes.
     */
    const record_highlight_gesture = useCallback((
        deltas: readonly HighlightCellDelta[],
        label: string,
    ) => {
        if (deltas.length === 0) return;
        const record = history_store_ref.current!.stage_record({
            label,
            changes: highlight_history_source(deltas, meta_ref.current?.sheets ?? []),
        });
        commit_staged_transaction([record]);
    }, []);

    const show_warning = useCallback((message: string) => {
        host_bridge.postMessage({ type: 'showWarning', message });
    }, []);

    // ---- A press of Undo or Redo that has to wait (see `history-press-model.ts`) ----
    //
    // Two slots. `held_press_ref` is the press waiting for something this
    // window started to clear; `retry_press_ref` is a press whose replay a
    // refresh overtook, waiting to be tried again. Every reader (the gate,
    // `press_admits`, the grid's `history_press_held`) reads the slots when it
    // is asked, so nothing has to be kept in step with them.
    const held_press_ref = useRef<HeldPress | null>(null);
    const retry_press_ref = useRef<RetryPress | null>(null);
    /** Numbers the presses. A gesture that will finish later takes its value as a ticket. */
    const press_epoch_ref = useRef(0);
    // The first ticket of the document now under the history. A ticket below
    // it was taken in a document that has since been replaced: whatever that
    // gesture does when it ends is not about a press made in this one.
    const document_ticket_floor_ref = useRef(0);
    /**
     * The ticket of the work that is asking a gesture gate right now, set for
     * the length of one synchronous call (`with_gesture_ticket`). Work made
     * before a waiting press carries a ticket lower than the press's epoch,
     * and is admitted; with none set, nothing is.
     */
    const ambient_ticket_ref = useRef<number | undefined>(undefined);
    /**
     * How many snapshots this window has applied. Not `snapshot_applied_seq_ref`,
     * which also counts a delivery that was acknowledged and not applied: only
     * an applied snapshot ends the wait for a session to finish going, and only
     * one says the refresh a view replay lost to has arrived. (A cell or
     * structural replay's retry counts every acknowledged delivery instead:
     * see `RetryPress.awaits`.)
     */
    const applied_snapshot_seq_ref = useRef(0);
    /** Set while the drain attempts the retry, so a hold it meets is written back to the retry's slot. */
    const attempting_retry_ref = useRef<RetryPress | null>(null);
    const draining_history_press_ref = useRef(false);
    const history_press_timer_ref = useRef<number | undefined>(undefined);
    /**
     * `snapshot_applied_seq_ref` (every delivery acknowledged, applied or not)
     * as it was when the coordinator last posted a preparation.
     */
    const replay_posted_after_ref = useRef(0);
    /**
     * After a commit answered `viewMoved`: the file and the durable state
     * revision its write produced. A delivery for that file whose state is
     * older was made before the write; it arrives late (a retried post) and
     * is not applied, however often it is retried. Another delivery below it
     * means the host's material never reached the write: the floor gives way
     * then, so this view keeps taking deliveries. Cleared by a delivery at or
     * past it.
     */
    const replay_state_floor_ref = useRef<{
        readonly fileId: string;
        readonly stateRevision: number;
        /** The delivery the floor has turned away, as often as it is retried. */
        readonly rejected?: number;
    } | null>(null);
    /**
     * The worksheets as they stood when the last replay's preparation was
     * sent, by its replay: the host resolves sheet indices against that view.
     * A commit answered after its view moved (`viewMoved`) names sheets by
     * those indices, and is landed on the same worksheets wherever they are
     * now. Replaced by the next preparation.
     */
    const replay_commit_sheets_ref = useRef<{
        readonly replayId: string;
        readonly sheets: readonly { readonly name: string; readonly worksheetId: string | undefined }[];
    } | null>(null);
    /**
     * Row and column admissions the host has granted and the grid has not
     * finished installing. The request is forgotten when its answer arrives,
     * and the grid installs the rows in a continuation; a press held behind
     * the admission waits for that too.
     */
    const unsettled_admissions_ref = useRef(new Set<string>());
    /** Row-height and width replays being watched for an answer, by request. */
    const view_replay_watch_ref = useRef(new Map<string, number>());
    // When each sentence about Undo or Redo was last said.
    const history_messages_said_ref = useRef(new Map<string, number>());
    // Bumped to render, and so to drain, when what a waiting press waits for
    // may have cleared without any other state changing.
    const [, set_history_press_tick] = useState(0);

    /**
     * Say something about an Undo or a Redo. The same sentence is not said
     * twice within two seconds: a key held down against something that does
     * not clear would otherwise put up one dialog per repeat. A deliberate
     * second press, later, is told again. Each sentence is remembered on its
     * own, so another said in between does not make a repeat new: a second
     * press that ends with the same sentence within two seconds, even with
     * another between, is not told again (a press refused at once, with the
     * key held down, would otherwise put up a box per repeat). `force` says
     * it regardless, for the one answer whose press is not a repeat of the
     * last (a press dropped behind a gesture): it is still remembered.
     */
    const say_history = useCallback((message: string, force = false) => {
        const now = Date.now();
        const said = history_messages_said_ref.current;
        const at = said.get(message);
        if (!force && history_message_is_repeat(at === undefined ? null : { message, at }, message, now)) return;
        for (const [other, other_at] of said) {
            if (!history_message_is_repeat({ message: other, at: other_at }, other, now)) said.delete(other);
        }
        said.set(message, now);
        host_bridge.postMessage({ type: 'showWarning', message });
    }, []);

    /**
     * Whether this window must be reopened before it takes a change, saying so
     * when it must (once for a burst, by `say_history`'s repeat rule).
     */
    const refused_for_reopen = useCallback((): boolean => {
        if (!reopen_required_ref.current) return false;
        say_history(REOPEN_REQUIRED_MESSAGE);
        return true;
    }, [say_history]);
    useLayoutEffect(() => { refused_for_reopen_ref.current = refused_for_reopen; }, [refused_for_reopen]);

    /**
     * This window has said it no longer matches its file. From here it sends
     * nothing of its stores to the host and takes no recorded change, until a
     * new document replaces every store (`lower_reopen_fence`): a store that
     * disagrees with the file would otherwise be written over the change.
     */
    const raise_reopen_fence = useCallback(() => {
        reopen_required_ref.current = true;
        // In the render that follows (a task later at most), the grid closes
        // an open editor without committing it (its `editable_cells` layout
        // effect); until then the barrier refuses its commit.
        set_reopen_required(true);
        publication_fence.raise();
        // A Header Row change queued behind the replay ends now.
        wake_header_drain_ref.current();
    }, []);
    /**
     * A new document has replaced every store from durable state, so this
     * window matches its file again. The publications of the stores it
     * replaced are forgotten, if the fence held them back: nothing will retry
     * them, and one the host dropped would hold every wait for acknowledgement.
     */
    const lower_reopen_fence = useCallback(() => {
        if (publication_fence.is_raised()) publication_fence.forget_outstanding();
        publication_fence.lower();
        reopen_required_ref.current = false;
        set_reopen_required(false);
    }, []);
    // The bridge outlives this window's App.
    useLayoutEffect(() => () => publication_fence.lower(), []);

    /**
     * One timer for both slots, at the earlier of their two bounds. It forces
     * a render, and the drain that follows ends the press with its message.
     * So a wake that is missed costs a late answer and never a lost press.
     */
    const arm_history_press_timer = useCallback(() => {
        window.clearTimeout(history_press_timer_ref.current);
        history_press_timer_ref.current = undefined;
        const starts = [held_press_ref.current?.press.started, retry_press_ref.current?.press.started]
            .filter((started): started is number => started !== undefined);
        if (starts.length === 0) return;
        const due = Math.min(...starts) + HISTORY_PRESS_HOLD_MS - Date.now();
        history_press_timer_ref.current = window.setTimeout(() => {
            history_press_timer_ref.current = undefined;
            set_history_press_tick((tick) => tick + 1);
        }, Math.max(0, due));
    }, []);

    /**
     * Render, so that the drain asks again, because something a waiting press
     * may be waiting for has ended. Nothing when no press waits. The drain's
     * own bookkeeping does not wake it: what it writes it has just read.
     */
    const wake_history_press = useCallback(() => {
        if (draining_history_press_ref.current) return;
        if (held_press_ref.current === null && retry_press_ref.current === null) return;
        set_history_press_tick((tick) => tick + 1);
    }, []);

    /**
     * The ticket a gesture takes when it is made, to show at the gate when it
     * finishes. A gesture started inside the continuation of another (an
     * append a held key's session grant runs) is part of that one, and takes
     * its ticket.
     */
    const gesture_ticket = useCallback(
        (): number => ambient_ticket_ref.current ?? press_epoch_ref.current,
        [],
    );
    /** Run `run` as the work that took `ticket`. Synchronous: an await inside is outside. */
    const with_gesture_ticket = useCallback(<T,>(ticket: number, run: () => T): T => {
        const outer = ambient_ticket_ref.current;
        ambient_ticket_ref.current = ticket;
        try {
            return run();
        } finally {
            ambient_ticket_ref.current = outer;
        }
    }, []);
    /**
     * Whether what is asking may be recorded although a press may be waiting:
     * no press waits (a typing hold reserves nothing), or the work that asks
     * was made before every press that does.
     */
    const press_admits = useCallback((): boolean => {
        const held = held_press_ref.current;
        return press_admits_ticket({
            held_epoch: held === null || held.typing === true ? undefined : held.press.epoch,
            retry_epoch: retry_press_ref.current?.press.epoch,
            ticket: ambient_ticket_ref.current,
        });
    }, []);
    /** Whether a press is waiting that a new gesture must not get under. */
    const history_press_held = useCallback((): boolean => {
        const held = held_press_ref.current;
        return (held !== null && held.typing !== true) || retry_press_ref.current !== null;
    }, []);

    /**
     * Hold a press. The one writer of either slot for a press that waits, and
     * the one place the bound is enforced: a press already at its bound is
     * not held, it says why it did not run.
     *
     * While the drain is attempting the retry, a hold belongs to the retry and
     * goes back to its slot, never to the held one, which may hold the press
     * waiting behind it.
     */
    const hold_history_press = useCallback((
        press: HistoryPress,
        wait: HistoryPressWait,
        options: { readonly step_wait?: HeldPress['step_wait']; readonly typing?: true } = {},
    ) => {
        const retry = attempting_retry_ref.current;
        if (history_press_bound_reached(press, Date.now())) {
            if (retry !== null && retry_press_ref.current === retry) {
                // The retry's attempt is ended by its bound: the press behind
                // it was for the stack as the retry would have left it. Keys
                // on their way to an editor are not that press: they keep
                // their hold, and its own bound answers it.
                retry_press_ref.current = null;
                if (held_press_ref.current?.typing !== true) held_press_ref.current = null;
            }
            say_history(view_replay_wait_warning(wait, press.direction));
            arm_history_press_timer();
            return;
        }
        const waiting: HistoryPress = wait === 'finishing' && press.release_seq === undefined
            ? { ...press, release_seq: applied_snapshot_seq_ref.current }
            : press;
        if (retry !== null && retry_press_ref.current === retry) {
            retry_press_ref.current = {
                press: waiting,
                entry: retry.entry,
                posted_after: retry.posted_after,
                awaits: retry.awaits,
                ...(options.step_wait === undefined ? {} : { step_wait: options.step_wait }),
            };
            arm_history_press_timer();
            return;
        }
        const other = held_press_ref.current;
        if (other !== null && other.press.epoch !== press.epoch) {
            // An attempt already under way has to wait again, and a press made
            // meanwhile is waiting behind it. The same direction is the same
            // request, and the earlier press stands for both; the other
            // direction cancels it, as it would have had this press still been
            // waiting when it was made.
            if (other.press.direction !== press.direction) {
                held_press_ref.current = null;
                arm_history_press_timer();
                return;
            }
            // Not reached today (a press is not made while one is held, and the
            // drain empties the slot before it attempts), kept so the older
            // press always stands for both.
            if (other.press.epoch < press.epoch) return;
        }
        held_press_ref.current = {
            press: waiting,
            wait,
            ...(options.step_wait === undefined ? {} : { step_wait: options.step_wait }),
            ...(options.typing === true ? { typing: true as const } : {}),
        };
        arm_history_press_timer();
    }, [arm_history_press_timer, say_history]);

    /**
     * Watch a row-height or width replay for an answer. Neither is sure to
     * draw anything while it is out, so one the host never answers would be a
     * press that changed nothing and said nothing. After as long as a lease
     * lasts the press says so, once; the request stays pending, so a late
     * answer still settles it.
     */
    const watch_view_replay = useCallback((key: string, direction: HistoryDirection) => {
        window.clearTimeout(view_replay_watch_ref.current.get(key));
        view_replay_watch_ref.current.set(key, window.setTimeout(() => {
            view_replay_watch_ref.current.delete(key);
            say_history(history_unanswered_warning(direction));
        }, HISTORY_REPLAY_LEASE_TTL_MS));
    }, [say_history]);
    /** The watched request was answered, overtaken, or abandoned. All of them, with no key. */
    const unwatch_view_replay = useCallback((key?: string) => {
        const watches = view_replay_watch_ref.current;
        if (key === undefined) {
            for (const timer of watches.values()) window.clearTimeout(timer);
            watches.clear();
            return;
        }
        window.clearTimeout(watches.get(key));
        watches.delete(key);
    }, []);

    /**
     * A key, a double click, or a Save the grid refused because a press of
     * Undo or Redo is waiting. Through `say_history`, because a key repeats.
     */
    const say_history_hold_gesture = useCallback(() => {
        say_history(VIEW_GESTURE_WAIT_MESSAGE);
    }, [say_history]);

    /**
     * Drop every waiting press and say nothing: the document was replaced, or
     * the person cancelled. A Cancel keeps a press held for typed keys: those
     * keys are on their way to an editor, not waiting for what was cancelled.
     */
    const drop_history_presses = useCallback((options: { readonly keep_typing?: boolean } = {}) => {
        if (held_press_ref.current === null && retry_press_ref.current === null) return;
        if (!(options.keep_typing === true && held_press_ref.current?.typing === true)) {
            held_press_ref.current = null;
        }
        retry_press_ref.current = null;
        arm_history_press_timer();
    }, [arm_history_press_timer]);

    /**
     * A replay did not run, or did not finish, and the person is told why.
     * The press waiting behind it is dropped: it was for the stack as that
     * replay would have left it.
     */
    const refuse_history_press = useCallback((message: string | null) => {
        if (message !== null) say_history(message);
        if (held_press_ref.current !== null && held_press_ref.current.typing !== true) {
            held_press_ref.current = null;
            arm_history_press_timer();
        }
    }, [arm_history_press_timer, say_history]);

    /**
     * A gesture of the person's own, made before the held press, ended
     * without recording a step. The press was made for that step and would
     * otherwise undo the one under it, so it is not carried out (as with
     * Cancel). Unlike a Cancel the person did not ask for that, so it is said:
     * in a microtask, after whatever the gesture says of itself in the same
     * task, and for every press dropped. A refusal that says why must say it
     * in the task that drops the press (each does today): one said after an
     * await would come after this sentence instead of before it. The repeat rule
     * is for a key held against a hold that does not clear; a dropped press
     * empties the slot, so the next one is a new press with its own hold.
     */
    const drop_press_behind_unrecorded_gesture = useCallback(() => {
        const held = held_press_ref.current;
        if (held === null || held.typing === true) return;
        refuse_history_press(null);
        const message = history_gesture_unrecorded_warning(held.press.direction);
        queueMicrotask(() => say_history(message, true));
    }, [refuse_history_press, say_history]);

    /**
     * A gesture of the person's own ended in the grid without recording
     * anything (its session refused, its view moved, refused when it ran).
     * A press held behind it was made after it, for its step; it is dropped
     * rather than undo the step under it (as with Cancel). Only for a gesture
     * made before the press: one made after it, refused because of it, says
     * nothing about it.
     */
    const drop_press_for_unrecorded_gesture = useCallback((ticket: number | undefined) => {
        const held = held_press_ref.current;
        if (held === null || held.typing === true) return;
        if (ticket === undefined || ticket >= held.press.epoch) return;
        // Made in a document that has since been replaced.
        if (ticket < document_ticket_floor_ref.current) return;
        drop_press_behind_unrecorded_gesture();
    }, [drop_press_behind_unrecorded_gesture]);

    /**
     * A replay ended because the host's view had moved under it and the host
     * wrote nothing. The site only hands the press over. Whether the refresh
     * it lost to is already here, which decides between trying again and
     * saying so, is the drain's to read: the sites inside the snapshot
     * handler run before that handler has counted its own snapshot.
     */
    const hand_over_history_retry = useCallback((
        press: HistoryPress,
        entry: HistoryEntry,
        posted_after: number,
        awaits: RetryPress['awaits'] = 'applied',
    ) => {
        retry_press_ref.current = { press, entry, posted_after, awaits };
        arm_history_press_timer();
        wake_history_press();
    }, [arm_history_press_timer, wake_history_press]);

    /**
     * Fold the open cell editor before a view request is posted.
     *
     * No cell editor is open while a view request of this window is in
     * flight: its text is committed here first, and cells offer no editor
     * until the request settles (`view_request_pending`). So the install has
     * nothing to fold, the window can always adopt what the host installed,
     * and nothing is recorded between a gesture's request and its step.
     *
     * `fenced_empty_ok`: under an exiting session's fence the fold would
     * otherwise refuse with nothing open.
     *
     * `'refused'` has said why; the draft stays open and nothing is posted.
     * `'folded'` committed an edit, which recorded a step.
     */
    const fold_before_view_request = useCallback((
        // How to say a fold that would not commit. A press of Undo or Redo
        // says it through `say_history`, so a held key puts up one box.
        say: (message: string) => void = show_warning,
    ): 'refused' | 'folded' | 'nothing' => {
        const before = history_store_ref.current!.snapshot();
        if (editing_ref.current?.commit_live_edit({ fenced_empty_ok: true }) === false) {
            say(FOLD_REFUSED_MESSAGE);
            return 'refused';
        }
        return history_store_ref.current!.snapshot() === before ? 'nothing' : 'folded';
    }, [show_warning]);

    /**
     * Record a view gesture this window made (a sort, a filter, hidden rows,
     * hidden columns, a row resize or reset), once the host has applied it. A
     * column-width gesture can span worksheets and records its own action in
     * `settle_width_write`, the same way.
     *
     * Like a highlight, with nothing staged alongside and no editing session:
     * the change has already happened on the host and in durable state. A
     * view step does not make the document unsaved.
     */
    const record_view_step = useCallback((step: ViewStep | undefined) => {
        if (step === undefined) return;
        const record = history_store_ref.current!.stage_record({
            label: step.label,
            changes: [{ kind: 'view', delta: step.delta }],
        });
        commit_staged_transaction([record]);
    }, []);

    /**
     * Move a replayed view step to the other stack, and say what the replay
     * did less than the step says, if anything.
     *
     * `whole` is true when nothing of the step was applied (every part was
     * skipped). `partly` is true when the host installed something other than
     * what the replay asked for. Answers whether the entry moved.
     */
    const land_view_replay = useCallback((
        replay: ViewReplay,
        worksheet: WorksheetTarget,
        whole: boolean,
        partly = false,
    ): boolean => {
        const move = history_store_ref.current!.stage_move(replay.direction, replay.entry);
        commit_staged_transaction([move]);
        const label = replay.entry.action.label;
        if (move.outcome.kind === 'dropped') {
            // History was cleared or cut off behind a barrier during the round
            // trip. The view change stands; it has no entry any more.
            say_history(view_replay_dropped_warning(replay.direction));
            return false;
        }
        if (replay.skipped.length > 0) {
            // In a workbook with several worksheets the message says which one.
            const sheets = meta_ref.current?.sheets ?? [];
            const index = worksheet_target_index(sheets, worksheet);
            const sheet_name = sheets.length > 1
                ? (index === undefined ? undefined : sheets[index]?.name) ?? worksheet.sheetName
                : undefined;
            say_history(view_skip_warning(replay.direction, label, replay.skipped, whole, sheet_name));
        } else if (partly) {
            say_history(view_partly_applied_warning(replay.direction, label));
        }
        return true;
    }, [say_history]);

    /**
     * Settle a column visibility write.
     *
     * `landed`: the durable state holds it. A gesture records its step and a
     * replay moves its entry. Neither writes the view: after the write was
     * posted only a snapshot changes what the sheet shows, so a newer state
     * another window made durable is never overwritten by an answer.
     *
     * Not landed, by the host's answer: nothing was written. The sheet is put
     * back to what it showed before, unless a snapshot has adopted column
     * visibility since the write was posted; then the view is already the
     * host's and is left alone. Not landed, by a snapshot that overtook the
     * write: the view is the snapshot's and nothing is put back.
     */
    const settle_column_write = useCallback((
        pending: PendingColumnWrite,
        landed: boolean,
        by: 'answer' | 'snapshot',
    ) => {
        const sheets = meta_ref.current?.sheets ?? [];
        const index = worksheet_target_index(sheets, pending.worksheet);
        const sheet = index === undefined ? undefined : sheets[index];
        if (landed) {
            if (pending.replay !== undefined) {
                land_view_replay(pending.replay, pending.worksheet, false);
            } else if (sheet !== undefined && index !== undefined) {
                record_view_step(columns_view_step(
                    {
                        sheetIndex: index,
                        sheetName: sheet.name,
                        ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                    },
                    pending.schema,
                    hidden_source_columns(pending.before, sheet.columnCount),
                    hidden_source_columns(pending.after, sheet.columnCount),
                ));
            } else {
                // Its worksheet is gone: nothing recorded for the person's
                // own gesture, and a press held behind it was for its step.
                drop_press_behind_unrecorded_gesture();
            }
            return;
        }
        // Auto-fit, ended for the sheet when the write was posted, stays
        // ended: its fitted widths were dropped then, and the person turns it
        // back on with the toolbar.
        if (by === 'answer' && !pending.snapshotAdopted && index !== undefined) {
            const restored = [...(state_ref.current.columnVisibility ?? [])];
            restored[index] = pending.before;
            state_ref.current = { ...state_ref.current, columnVisibility: restored };
            set_column_visibility(restored);
        }
        if (pending.replay !== undefined) {
            // The write was composed against a snapshot the host had already
            // replaced. Tried again once that refresh is here, or said.
            hand_over_history_retry(pending.replay.press, pending.replay.entry, pending.replay.posted_after);
        } else {
            if (by === 'answer') {
                host_bridge.postMessage({ type: 'showWarning', message: COLUMN_WRITE_REFUSED_MESSAGE });
            }
            // The person's own gesture was refused, or a refresh does not show
            // it: nothing was recorded. A press held behind it was for its
            // step, and would otherwise undo the one under it (as with Cancel).
            drop_press_behind_unrecorded_gesture();
        }
    }, [drop_press_behind_unrecorded_gesture, hand_over_history_retry, land_view_replay, record_view_step]);

    /** `settle_width_write`, which is declared with the width gestures further down. */
    const settle_width_write_ref = useRef<(
        pending: PendingWidthWrite,
        outcome: WidthWriteOutcome,
    ) => void>(() => {});
    /**
     * View requests a refresh of the same document overtook: their pending
     * records, taken where the snapshot handler drops them and settled once it
     * has adopted the snapshot's state.
     */
    const overtaken_view_requests_ref = useRef<{
        views: PendingViewTransform[];
        column: PendingColumnWrite | null;
        width: PendingWidthWrite | null;
    }>({ views: [], column: null, width: null });

    /**
     * When a refresh overtakes a pending view request, the refresh decides
     * whether it landed. Its own answer no longer matches and is ignored, and
     * the host may or may not have applied it.
     *
     * Each request's worksheet is resolved by identity first: a reload can
     * reorder or remove worksheets, and the sheet now at the old index is not
     * the one the request was for.
     *
     *  - A sort or filter gesture landed only if the adopted rules equal its
     *    target in every slice it changed; its step is then that difference
     *    and nothing else the refresh carried.
     *  - A Hide rows gesture has no target this window knows, so a snapshot
     *    cannot say whether it landed. Nothing is recorded for it.
     *  - A replay moves if the adopted rules hold its target; otherwise its
     *    entry stays and the person is told.
     *  - A column write landed if the sheet's adopted hidden columns are the
     *    ones it asked for.
     *
     * None of them landed if the refresh brought the worksheet other columns
     * than the request was composed against. The host drops rules and hidden
     * columns that named the old ones, so "nothing sorted" or "nothing
     * hidden" can equal the target of a gesture that cleared something, and a
     * step recorded from that would name old column positions among the new
     * columns.
     */
    const settle_overtaken_view_requests = useCallback(() => {
        const { views, column, width } = overtaken_view_requests_ref.current;
        if (views.length === 0 && column === null && width === null) return;
        overtaken_view_requests_ref.current = { views: [], column: null, width: null };
        const sheets = meta_ref.current?.sheets ?? [];
        for (const pending of views) {
            const index = worksheet_target_index(sheets, pending.worksheet);
            const sheet = index === undefined ? undefined : sheets[index];
            const adopted = index === undefined ? undefined : state_ref.current.transforms?.[index];
            const same_columns = sheet !== undefined
                && transform_schema_for_sheet(sheet) === pending.schema;
            if (pending.replay !== undefined) {
                if (sheet === undefined) {
                    refuse_history_press(
                        history_refusal_warning('unavailable', pending.replay.direction, undefined),
                    );
                } else if (
                    same_columns
                    && pending.target !== undefined
                    && transform_slices_equal(pending.replay.delta, pending.target, adopted)
                ) {
                    land_view_replay(pending.replay, pending.worksheet, false);
                } else {
                    hand_over_history_retry(
                        pending.replay.press,
                        pending.replay.entry,
                        pending.replay.posted_after,
                    );
                }
                continue;
            }
            const step = sheet === undefined
                || index === undefined
                || pending.target === undefined
                || !same_columns
                ? undefined
                : overtaken_transform_step(
                    {
                        sheetIndex: index,
                        sheetName: sheet.name,
                        ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                    },
                    pending.schema,
                    pending.baseline,
                    pending.target,
                    adopted,
                );
            if (step === undefined) {
                // Nothing recorded for the person's own gesture: a press held behind it
                // was for its step, and would otherwise undo the one under it (as with Cancel).
                drop_press_behind_unrecorded_gesture();
                continue;
            }
            record_view_step(step);
        }
        if (column !== null) {
            const index = worksheet_target_index(sheets, column.worksheet);
            const sheet = index === undefined ? undefined : sheets[index];
            const landed = sheet !== undefined
                && index !== undefined
                && transform_schema_for_sheet(sheet) === column.schema
                && JSON.stringify(
                    hidden_source_columns(state_ref.current.columnVisibility?.[index], sheet.columnCount),
                ) === JSON.stringify(hidden_source_columns(column.after, sheet.columnCount));
            settle_column_write(column, landed, 'snapshot');
        }
        // A width write cannot be judged by what the refresh shows: its step
        // is what the host says it changed, and that answer no longer
        // matches. Nothing is recorded; a replay says so and stays (pressing
        // again is right whether or not it landed).
        if (width !== null) settle_width_write_ref.current(width, { kind: 'overtaken' });
        // A settled replay renders nothing; a queued header change waits on it.
        wake_header_drain();
    }, [drop_press_behind_unrecorded_gesture, land_view_replay, record_view_step, refuse_history_press, settle_column_write]);

    /**
     * The one outstanding replay, if any.
     *
     * A ref rather than state, for the same reason as the history store: a replay
     * starts inside an event handler and the reservation has to be visible to the
     * next keypress immediately, not after a render.
     */
    const replay_coordinator_ref = useRef<HistoryReplayCoordinator | null>(null);
    /** Structural-only replay is local, but reserves the same chronological stack. */
    const pending_row_replay_busy_ref = useRef(false);
    const pending_row_replay_plan_ref = useRef<{
        readonly entryId: object;
        readonly direction: HistoryDirection;
        readonly plans: readonly PendingRowHistoryPlan[];
        readonly restorationRequestIds: readonly string[];
        readonly settleRestorations: readonly ((accepted: boolean) => void)[];
    } | null>(null);
    /**
     * Acquire an edit session for a replay that has none.
     *
     * Reached through a ref because the coordinator is built during the first
     * render, before the callback this delegates to exists — and it must not be
     * rebuilt when that callback's dependencies move, since it holds the
     * reservation the next keypress is refused against.
     */
    const ensure_replay_session_ref = useRef<(() => Promise<boolean>) | null>(null);
    // Declared before the block below rather than after it: the block closes over
    // this ref, and while `next_id` is only ever called later, a `const` read from
    // its own TDZ is a throw waiting for someone to move a call.
    const replay_id_counter_ref = useRef(0);
    if (replay_coordinator_ref.current === null) {
        replay_coordinator_ref.current = create_history_replay_coordinator({
            history: () => history_store_ref.current!.snapshot(),
            ensure_session: () => ensure_replay_session_ref.current?.() ?? Promise.resolve(false),
            entry_for_replay: (entry) => entry_for_replay_ref.current(entry),
            read_overlay: (worksheet, source_row, source_column) => {
                // Resolved through the live workbook rather than the target's own
                // index, because history is workbook-wide: an action recorded
                // before a reorder names its sheet by identity, and the index it
                // carries may now be another sheet entirely.
                const sheets = meta_ref.current?.sheets;
                if (sheets === undefined) return undefined;
                const sheet_index = worksheet_target_index(sheets, worksheet);
                if (sheet_index === undefined) return undefined;
                const store = edit_session_registry_ref.current!.for_sheet(sheet_index);
                const entry = store.get(cell_key(source_row, source_column));
                // Absent is a fact about a cell we CAN see. The registry answers
                // for every sheet in the workbook, so there is no third state
                // here — an unopened sheet's store is simply empty.
                return entry === undefined
                    ? absent_overlay()
                    : overlay_state_from_dirty_entry(entry);
            },
            read_structural: (worksheet) => {
                const sheets = meta_ref.current?.sheets;
                if (sheets === undefined) return undefined;
                const sheet_index = worksheet_target_index(sheets, worksheet);
                return sheet_index === undefined
                    ? undefined
                    : edit_session_registry_ref.current!
                        .pending_rows_for_sheet(sheet_index)
                        .snapshot();
            },
            row_admission_request_ids: () =>
                pending_row_replay_plan_ref.current?.restorationRequestIds ?? [],
            preplanned_structures: (entry, direction) => {
                const planned = pending_row_replay_plan_ref.current;
                return planned !== null
                    && planned.entryId === entry.id
                    && planned.direction === direction
                    ? planned.plans
                    : undefined;
            },
            post: (message) => {
                // What a refused preparation or commit is measured against:
                // a delivery acknowledged since this post (applied or not)
                // is the refresh it lost to (`RetryPress.awaits`).
                if (message.type === 'prepareHistoryReplay') {
                    replay_posted_after_ref.current = snapshot_applied_seq_ref.current;
                    replay_commit_sheets_ref.current = {
                        replayId: message.request.replayId,
                        sheets: (meta_ref.current?.sheets ?? []).map((sheet) => ({
                            name: sheet.name,
                            worksheetId: sheet.worksheetId,
                        })),
                    };
                }
                host_bridge.postMessage(message);
            },
            next_id: (prefix) => `${prefix}-${++replay_id_counter_ref.current}`,
        });
    }

    /**
     * Land a committed replay: the stores and the history move as ONE transaction.
     *
     * The history is a participant, not a consequence. If the edit stores moved
     * and the history did not, the next undo would replay a gesture the document
     * has already walked back; if the history moved and the stores did not, undo
     * would have silently skipped one. Both are states no further undo or redo
     * could describe, so the three passes decide together — and nothing between
     * validating and committing may await or set React state.
     */
    const apply_committed_replay = useCallback((
        committed: HistoryReplayCommitted,
        entry: HistoryEntry,
        direction: HistoryDirection,
    ): ReplayLanding => {
        const session_id = csv_edit_session_id_ref.current;
        const registry = edit_session_registry_ref.current!;
        // Grouped per store, because a store owns exactly one worksheet and a
        // workbook-wide gesture spans several. The host's accepted writes carry
        // the resolved sheet index, so this never re-resolves a target.
        const by_sheet = new Map<number, StoreWrite[]>();
        for (const write of committed.cells) {
            const writes = by_sheet.get(write.resolvedSheetIndex) ?? [];
            writes.push({ key: write.key, entry: replayed_store_entry(write.entry) });
            by_sheet.set(write.resolvedSheetIndex, writes);
        }
        const structural = pending_row_replay_plan_ref.current;
        const action_has_structural_changes = entry.action.changes.some((change) =>
            is_structural_history_change(change));
        const accepted_structures = committed.structures ?? [];
        const requested_structures = accepted_structures.filter(
            (accepted) => accepted.hostDerived !== true,
        );
        if (action_has_structural_changes) {
            if (
                structural === null
                || structural.entryId !== entry.id
                || structural.direction !== direction
            ) return 'diverged';
            if (requested_structures.length !== structural.plans.length) return 'diverged';
        } else if (requested_structures.length > 0) {
            return 'diverged';
        }

        const sheets = meta_ref.current?.sheets;
        if (sheets === undefined) return 'diverged';
        // The view moved after the host's write (see `committed_for_view`).
        const view_moved = committed.viewMoved === true;
        // No session holds these stores any more: what they held is replaced
        // from durable state when one is acquired.
        if (
            view_moved
            && session_id === undefined
            && (committed.cells.length > 0 || accepted_structures.length > 0)
        ) return 'unstaged';
        const structural_by_sheet = new Map<number, {
            readonly expected: PendingStructuralChanges;
            readonly desired: PendingStructuralChanges;
        }>();
        // Sheets an arm names, so two arms for one sheet are refused even
        // where one stages nothing.
        const structural_sheets = new Set<number>();
        for (const accepted of accepted_structures) {
            if (structural_sheets.has(accepted.resolvedSheetIndex)) return 'diverged';
            structural_sheets.add(accepted.resolvedSheetIndex);
            if (accepted.hostDerived === true) {
                // A host-derived arm is deliberately only a conflict CAS patch.
                // Preserve every renderer-owned row/template field from the
                // store staged against instead of accepting a full sibling leaf
                // that would amplify the replay terminal.
                const current = registry.pending_rows_for_sheet(
                    accepted.resolvedSheetIndex,
                ).snapshot();
                const conflicts = JSON.stringify(current.conflicts);
                // Already in place: a delivery made from the written state
                // reached the window first.
                if (conflicts === JSON.stringify(accepted.desiredConflicts)) continue;
                // Conflicts the host computed since (a delivery brought them,
                // before this answer or before an answer re-sent after a
                // lost one) are kept: the arm is only the host's conflicts.
                if (conflicts !== JSON.stringify(accepted.expectedConflicts)) continue;
                structural_by_sheet.set(accepted.resolvedSheetIndex, {
                    expected: current,
                    desired: { ...current, conflicts: accepted.desiredConflicts },
                });
            } else {
                const store = registry.pending_rows_for_sheet(accepted.resolvedSheetIndex).snapshot();
                const current = JSON.stringify(store);
                // Already in place stages nothing, as for a host-derived arm:
                // exactly, or with conflicts the host computed since (a
                // delivery made from the written state, before this answer or
                // before an answer re-sent after a lost one). Conflicts kept.
                // Not a store still where the replay found it: an arm that
                // changes only conflicts would read as in place there.
                if (current === JSON.stringify(accepted.desired)) continue;
                if (
                    current !== JSON.stringify(accepted.expected)
                    && JSON.stringify({ ...store, conflicts: accepted.desired.conflicts })
                        === JSON.stringify(accepted.desired)
                ) continue;
                if (view_moved && current !== JSON.stringify(accepted.expected)) {
                    // A delivery recomputed only the conflicts: the replay
                    // lands, with the conflicts the host has now.
                    if (JSON.stringify({ ...store, conflicts: accepted.expected.conflicts })
                        === JSON.stringify(accepted.expected)) {
                        structural_by_sheet.set(accepted.resolvedSheetIndex, {
                            expected: store,
                            desired: { ...accepted.desired, conflicts: store.conflicts },
                        });
                        continue;
                    }
                    // Anything else this window cannot follow: until a
                    // delivery reconciled it, the store would be published
                    // as it is, over the write.
                    return 'diverged';
                }
                structural_by_sheet.set(accepted.resolvedSheetIndex, {
                    expected: accepted.expected,
                    desired: accepted.desired,
                });
            }
        }

        // Validate each worksheet's COMPLETE desired envelope once. Validating
        // staged cells against old rows and staged rows against old cells can
        // falsely reject a valid transfer near the cap after the host has
        // already committed it. Once this pass succeeds, both store participants
        // stage under the same proof.
        const affected_sheet_indices = new Set([
            ...by_sheet.keys(),
            ...structural_by_sheet.keys(),
        ]);
        for (const sheet_index of affected_sheet_indices) {
            const sheet = sheets[sheet_index];
            if (sheet === undefined) return 'diverged';
            const desired_cells: Record<string, string | CsvDirtyEntry> = {};
            for (const [key, entry] of registry.for_sheet(sheet_index).snapshot()) {
                const wire = wire_entry_for_destination(entry);
                if (wire === undefined || wire === null) return 'diverged';
                desired_cells[key] = wire;
            }
            for (const write of by_sheet.get(sheet_index) ?? []) {
                if (write.entry === undefined) delete desired_cells[write.key];
                else {
                    const wire = wire_entry_for_destination(write.entry);
                    if (wire === undefined || wire === null) return 'diverged';
                    desired_cells[write.key] = wire;
                }
            }
            const desired_structural = structural_by_sheet.get(sheet_index)?.desired
                ?? registry.pending_rows_for_sheet(sheet_index).snapshot();
            try {
                assert_pending_changes_encoded_bound({
                    sheetIndex: sheet_index,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet.worksheetId }),
                    cells: desired_cells,
                    ...desired_structural,
                });
            } catch {
                return 'diverged';
            }
        }

        const staged: StagedMutation[] = [];
        for (const [sheet_index, writes] of by_sheet) {
            const staging = registry.for_sheet(sheet_index).stage_writes(
                session_id,
                writes,
                true,
            );
            // A store whose session moved on refuses to stage. Abandoning the
            // whole transaction is right: a replay is one gesture, and applying
            // the sheets that would still take it leaves half an undo.
            if (staging === undefined) return 'diverged';
            staged.push(staging);
        }
        for (const [sheet_index, changes] of structural_by_sheet) {
            const staging = registry.pending_rows_for_sheet(sheet_index).stage_replace(
                session_id,
                changes.expected,
                changes.desired,
                true,
            );
            if (staging === undefined) return 'diverged';
            staged.push(staging);
        }
        const move = history_store_ref.current!.stage_move(direction, entry);
        staged.push(move);
        // Highlights need no participant here: they are the host's own durable
        // state. The host publishes their refreshed snapshot only after this
        // terminal has moved every renderer-owned participant and history.
        const applied = commit_staged_transaction(staged);
        if (applied && structural?.entryId === entry.id) {
            structural.settleRestorations.forEach((settle) => settle(true));
            pending_row_replay_plan_ref.current = null;
        }
        return applied ? 'applied' : 'diverged';
    }, []);

    const set_csv_edit_session_id = useCallback((next: string | undefined) => {
        const previous = csv_edit_session_id_ref.current;
        if (next && next !== previous) {
            renderer_publication_fenced_session_ref.current = undefined;
        }
        if (previous && previous !== next) {
            pending_edit_durability.retire(previous);
            edit_session_registry_ref.current?.retire_parked();
        }
        if (previous !== next) append_composer_drafts_ref.current.clear();
        // Admissions belong to the session that asked for them.
        if (previous !== next) unsettled_admissions_ref.current.clear();
        csv_edit_session_id_ref.current = next;
        set_csv_edit_session_id_state(next);
        // A press waiting for the outgoing session to be gone.
        if (previous !== next) wake_history_press();
    }, [wake_history_press]);
    // The Save-refusal notice's input: an `.xlsx` conditional-formatting
    // element or data-validation rule on this worksheet that the current
    // layouts would split past the writer's cap, counted with the writer's
    // own partition.
    const rule_split_warning_messages = useMemo(() => {
        const rules = structural_editing?.sheets[active_sheet_index]?.relativeRules ?? [];
        if (!meta || edit_syntax !== 'markdown' || !editing_session_held || rules.length === 0) return [];
        try {
            const warnings = rule_split_warnings(
                pending_structure.anchor_inputs(),
                active_sheet_index,
                rules,
            );
            const changes = pending_structure.changes_for(active_sheet_index)
                ?? EMPTY_PENDING_STRUCTURAL_CHANGES;
            return warnings.map((warning) => rule_split_warning_message(warning, changes));
        } catch {
            return [];
        }
    }, [pending_structure, meta, edit_syntax, structural_editing, active_sheet_index, editing_session_held]);
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
    const [sheet_views, set_sheet_views_state] = useState<
        (SheetViewRecord | undefined)[]
    >([]);
    // Host messages can arrive before React commits the state update from the
    // previous message. Keep the installed-view record synchronous so a save
    // snapshot can decide whether preserving GridShell would retain display-row
    // state across a mapping change.
    const sheet_views_ref = useRef<(SheetViewRecord | undefined)[]>([]);
    const set_sheet_views = useCallback((
        update: (
            previous: (SheetViewRecord | undefined)[],
        ) => (SheetViewRecord | undefined)[],
    ) => {
        const next = update(sheet_views_ref.current);
        sheet_views_ref.current = next;
        set_sheet_views_state(next);
    }, []);
    const [pending_transforms, set_pending_transforms] = useState<boolean[]>([]);
    const [pending_transform_labels, set_pending_transform_labels] = useState<string[]>([]);
    const [pending_excel_header, set_pending_excel_header] = useState<string | null>(null);
    const [excel_header_status, set_excel_header_status] = useState('');
    /**
     * Wakes the header drain without polling: from an acknowledgement, a timer,
     * or the settling of in-flight work it waits on whose settling renders
     * nothing else.
     */
    const [, set_header_drain_tick] = useState(0);
    const wake_header_drain = useCallback(() => {
        set_header_drain_tick((tick) => tick + 1);
        // Whatever a header change waits for, a held press may wait for too.
        wake_history_press();
    }, [wake_history_press]);
    useLayoutEffect(() => { wake_header_drain_ref.current = wake_header_drain; }, [wake_header_drain]);
    const [filter_editor, set_filter_editor] = useState<{
        column_index: number;
        anchor: { left: number; top: number };
        restore_focus: () => void;
        origin: Exclude<TransformOrigin, 'restore'>;
    } | null>(null);
    const filter_editor_ref = useRef(filter_editor);
    filter_editor_ref.current = filter_editor;
    /**
     * Where the filter editor a refresh just closed was opened from. Nobody
     * dismissed that editor, so nobody handed focus back: the effect that
     * sees it gone does.
     */
    const filter_editor_closed_by_refresh_ref = useRef<
        Exclude<TransformOrigin, 'restore'> | null
    >(null);
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
    const [saved_row_focus, set_saved_row_focus] = useState<SavedRowFocus | null>(null);
    /** An unresolved structural save the host asks the user about. */
    const [structural_save_notice, set_structural_save_notice] =
        useState<StructuralSaveUnresolvedNotice | null>(null);
    const [pending_row_focus, set_pending_row_focus] = useState<PendingRowFocus | null>(null);
    const [grid_focus_restore, set_grid_focus_restore_state] =
        useState<GridFocusRestoreState | null>(null);
    const grid_focus_restore_ref = useRef<GridFocusRestoreState | null>(null);
    const set_grid_focus_restore = useCallback((
        next: React.SetStateAction<GridFocusRestoreState | null>,
    ) => {
        const resolved = typeof next === 'function'
            ? next(grid_focus_restore_ref.current)
            : next;
        grid_focus_restore_ref.current = resolved;
        set_grid_focus_restore_state(resolved);
    }, []);
    const [toolbar_focus_restore, set_toolbar_focus_restore] = useState<{
        sheet_index: number;
        document_epoch: number;
    } | null>(null);
    const [source_epoch, set_source_epoch] = useState(0);
    const [editing_status, set_editing_status] = useState<EditingStatus | null>(null);
    const [editing_status_sheet_index, set_editing_status_sheet_index] =
        useState<number | null>(null);
    const [cell_highlights, set_cell_highlights] = useState<CellHighlightState>();
    const [active_highlight_color, set_active_highlight_color] =
        useState<CellHighlightColor>('yellow');
    const [highlight_selection_available, set_highlight_selection_available] =
        useState(false);
    const [highlight_request_pending, set_highlight_request_pending] = useState(false);
    const [highlight_status, set_highlight_status] = useState('');
    // Last dismissed occurrence per worksheet. Keeping this per sheet prevents
    // acknowledging one tab from resurrecting an unchanged notice on another.
    const [dismissed_external_change_occurrences, set_dismissed_external_change_occurrences] =
        useState<Readonly<Record<string, number>>>({});
    // Dismissal keys of pending-change notices; each notice owns its own.
    const [dismissed_notices, set_dismissed_notices] = useState<ReadonlySet<string>>(() => new Set());
    const [open_external_change_occurrence, set_open_external_change_occurrence] =
        useState<string | null>(null);
    const [external_change_navigation_status, set_external_change_navigation_status] =
        useState('');
    const [external_change_navigation_pending_key, set_external_change_navigation_pending_key] =
        useState<string | null>(null);
    const external_change_navigation_pending_ref = useRef<string | null>(null);
    const external_change_navigation_request_ref = useRef(0);
    const external_change_navigation_context_ref = useRef<string | null>(null);
    const cancel_external_change_navigation = useCallback(() => {
        external_change_navigation_request_ref.current += 1;
        external_change_navigation_context_ref.current = null;
        external_change_navigation_pending_ref.current = null;
        set_external_change_navigation_pending_key(null);
    }, []);
    const external_change_review_button_ref = useRef<HTMLButtonElement | null>(null);
    const external_change_review_ref = useRef<HTMLElement | null>(null);
    const mount_external_change_review = useCallback((element: HTMLElement | null) => {
        const previous = external_change_review_ref.current;
        const restore_after_removal = element === null
            && previous !== null
            && previous.contains(document.activeElement);
        external_change_review_ref.current = element;
        external_change_navigation_context_ref.current =
            element?.dataset.navigationContext ?? null;
        if (element !== null) {
            element.focus();
            return;
        }
        if (!restore_after_removal) return;
        // Ref cleanup runs during the commit that removes the focused panel.
        // Defer until the same commit has installed either the newer banner or
        // the grid that remains after the notice resolves. A focus move made by
        // another handler in the meantime wins and is never overwritten.
        queueMicrotask(() => {
            if (external_change_review_ref.current !== null) return;
            if (
                document.activeElement !== document.body
                && document.activeElement !== document.documentElement
            ) return;
            const review_button = external_change_review_button_ref.current;
            if (review_button?.isConnected) review_button.focus();
            else grid_focus_ref.current?.focus();
        });
    }, []);
    const handle_external_change_item_detach = useCallback((
        key: string,
        previous: HTMLLIElement,
    ) => {
        const restore_review_focus = previous.contains(document.activeElement);
        const pending_navigation = external_change_navigation_pending_ref.current;
        const cancel_item_navigation = pending_navigation?.endsWith(`\u0000${key}`)
            === true;
        if (cancel_item_navigation) {
            external_change_navigation_request_ref.current += 1;
            external_change_navigation_pending_ref.current = null;
        }
        if (!restore_review_focus && !cancel_item_navigation) return;
        queueMicrotask(() => {
            if (cancel_item_navigation) {
                set_external_change_navigation_pending_key((current) => (
                    current === pending_navigation ? null : current
                ));
                set_external_change_navigation_status('');
            }
            if (!restore_review_focus) return;
            if (
                document.activeElement !== document.body
                && document.activeElement !== document.documentElement
            ) return;
            external_change_review_ref.current?.focus();
        });
    }, []);
    const external_change_occurrences_ref = useRef(new Map<string, {
        active: boolean;
        occurrence: number;
        observations: ReadonlyMap<string, string>;
        observedBases: ReadonlyMap<string, CsvObservedFileBase>;
        priorObservedBases: ReadonlyMap<string, CsvObservedFileBase>;
    }>());
    // A background save rejection may switch tabs while the keyboard still
    // belongs to the outgoing grid. Arm restoration through a ref so it is not
    // cleared by an intermediate native-message render before the target sheet
    // has mounted.
    const rejected_sheet_grid_focus_ref = useRef<GridFocusRestoreState | null>(null);
    // Stale-view signature the user acknowledged ("Dismiss"). Purely informational:
    // the banner it silences states that the displayed order does not recompute
    // mid-edit, which is intended, so acknowledging it must not touch the view. It
    // reappears once a *different* set of order-relevant edits — or a different
    // installed sort or filter — makes that statement a new fact.
    const [acknowledged_stale_signature, set_acknowledged_stale_signature] =
        useState<string | undefined>(undefined);
    // Keys the *host* refused a save over, from a saveResult's `rejection`. These
    // exist because the webview cannot inspect a filtered-out row, an evicted page,
    // or a row past the current row count. Without this state the review could not
    // explain or discard the pending edit that blocked the save.
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
        entries: Record<string, CsvDirtyEntry>;
        observed_bases?: Readonly<Record<string, CsvObservedFileBase>>;
        removed_keys?: readonly string[];
    } | null>(null);

    const state_ref = useRef<PerFileState>({});
    // GridShell populates this with imperative save/discard actions (the dirty map
    // lives next to the loader); App calls them from the toolbar + file-change review.
    const editing_ref = useRef<EditingHandle | null>(null);
    // GridShell populates this with a measure function returning fitted column
    // widths (null when nothing is loaded); App calls it from the auto-fit toggle.
    const auto_fit_ref = useRef<(() => Record<number, number> | null) | null>(null);
    // Its twin for Pending Columns, whose widths live in the Pending Changes.
    const pending_auto_fit_ref = useRef<(() => Record<string, number>) | null>(null);
    /**
     * Per sheet, the Pending Column widths a fit replaced (`undefined` for a
     * column that had none), so Restore puts them back as the source widths'
     * snapshot does.
     */
    const pending_auto_fit_snapshot_ref = useRef<(Record<string, number | undefined> | undefined)[]>([]);
    /** Write Pending Column widths into a sheet's Pending Changes, as a resize stores them. */
    const write_pending_column_widths = useCallback((
        sheet_index: number,
        widths: Readonly<Record<string, number | undefined>>,
    ) => {
        const store = edit_session_registry_ref.current!.pending_rows_for_sheet(sheet_index);
        const before = store.snapshot();
        const next = with_pending_column_widths(before, widths);
        if (next === undefined) return;
        const staged = store.stage_replace(csv_edit_session_id_ref.current, before, next);
        if (staged === undefined || !staged.valid()) return;
        staged.commit();
        staged.notify();
    }, []);
    // GridShell populates this with sheet-tab actions (select all / copy sheet)
    // for the mounted sheet; App calls them from the sheet-tab context menu.
    const grid_actions_ref = useRef<GridActionsHandle | null>(null);
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
    const append_request_seq_ref = useRef(0);
    const append_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    // Appends and inserts share one in-flight map, so every fence that waits
    // for an append (Save, Undo, Redo, other edits, releasing the session) also
    // waits for an insert, as the host's one reservation slot does.
    const pending_append_requests_ref = useRef(new Map<string, {
        readonly sourceGeneration: number;
        readonly editSessionId: string;
        readonly sheetIndex: number;
    } & ({
        readonly kind: 'append';
        readonly resolve: (result: AppendRowsAdmission | undefined) => void;
    } | {
        readonly kind: 'insert';
        readonly resolve: (result: StructuralInsertAdmission | undefined) => void;
    } | {
        readonly kind: 'insertColumns';
        readonly resolve: (result: StructuralColumnInsertAdmission | undefined) => void;
    })>());
    const [append_request_pending, set_append_request_pending] = useState(false);
    const restore_saved_rows_seq_ref = useRef(0);
    const pending_saved_row_restorations_ref = useRef(new Map<string, {
        readonly sourceGeneration: number;
        readonly expectedIds: readonly string[];
        readonly sheetIndex: number;
        readonly editSessionId: string;
        readonly resolve: (admission: {
            readonly requestId: string;
            readonly appendBasis: PendingAppendBasis;
            readonly settle: (accepted: boolean) => void;
        } | undefined) => void;
    }>());
    const tail_removal_validation_seq_ref = useRef(0);
    const pending_tail_removal_validations_ref = useRef(new Map<string, {
        readonly sourceGeneration: number;
        readonly resolve: (valid: boolean) => void;
    }>());
    const excel_header_request_seq_ref = useRef(0);
    const excel_header_request_prefix_ref = useRef(
        Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
            value.toString(36)).join('-'),
    );
    const pending_excel_header_ref = useRef<string | null>(null);
    /** The header queue's run in progress; see `HeaderRun` and `end_header_run`. */
    const header_run_ref = useRef<HeaderRun | null>(null);
    // The header fence (see `lower_header_fence`): raised by the gesture that
    // asks for a Header Row change, lowered by its last result. A ref for the
    // gesture gates, which read it synchronously; the state re-renders.
    const header_fence_ref = useRef(false);
    // A header result that needs a reload keeps the fence up with nothing
    // left to wait for; only a reload lowers it.
    const header_reload_required_ref = useRef(false);
    const lower_header_fence_ref = useRef<() => void>(() => {});
    /**
     * Why Save does nothing while the header fence is up. Reads refs only, so
     * the callbacks below may hold any render's copy.
     */
    const header_save_wait_message = () => (
        header_reload_required_ref.current
            ? 'Reload this window to finish the header row change, then save.'
            : 'Wait for the header row change to finish, then save.'
    );
    /** Say why Save does nothing while the header fence is up. */
    const warn_save_waits_for_header = useCallback(() => {
        host_bridge.postMessage({ type: 'showWarning', message: header_save_wait_message() });
    }, []);
    // The edit warning last shown for this fence, so a burst of keys says it
    // once; cleared when the fence drops.
    const header_edit_warning_ref = useRef<string | null>(null);
    /**
     * Say why an edit gesture does nothing while the header fence is up.
     *
     * `before_fence`: also speak while a header change is asked for and its
     * fence has not risen yet. Undo and Redo wait from the moment a header
     * gesture is asked: one that ran in that gap would move first, and the
     * header step recorded when the change settles would clear the redo it
     * had just made. Once per header change either way, so a held key gets
     * one message and not one per repeat.
     */
    const warn_edit_waits_for_header = useCallback((before_fence = false) => {
        if (!header_fence_ref.current && !before_fence) return;
        const message = header_reload_required_ref.current
            ? 'Reload this window to finish the header row change, then edit.'
            : 'Wait for the header row change to finish, then edit.';
        if (header_edit_warning_ref.current === message) return;
        header_edit_warning_ref.current = message;
        host_bridge.postMessage({ type: 'showWarning', message });
    }, []);
    /** Say why an edit gesture met cells the window keeps from taking it. */
    const warn_edit_paused = useCallback(() => {
        if (refused_for_reopen()) return;
        warn_edit_waits_for_header();
    }, [refused_for_reopen, warn_edit_waits_for_header]);
    /**
     * Say why Cmd/Ctrl+S saves nothing while edits are paused; starts nothing.
     * Once for a held key, by `say_history`'s repeat rule.
     */
    const warn_save_paused = useCallback(() => {
        if (reopen_required_ref.current) say_history(REOPEN_REQUIRED_SAVE_MESSAGE);
        else if (header_fence_ref.current) say_history(header_save_wait_message());
    }, [say_history]);
    const [header_fence, set_header_fence] = useState(false);
    // The header queue's verdict on a header result; see `drain_excel_header_queue`.
    const header_result_handler_ref = useRef<
        (result: ExcelHeaderSnapshotResult, delivery: number) => 'report' | 'retry' | 'handled'
    >(() => 'report');
    // Counts `snapshotApplied` acknowledgements, so a retried header request
    // can wait for the refresh its rejection was about to be acknowledged.
    const snapshot_applied_seq_ref = useRef(0);
    // Toolbar-originated Header Row actions can remount the grid when their
    // authoritative snapshot advances the generation. Remember which grid owned
    // keyboard focus so the acknowledgement can restore the newly mounted one.
    const pending_excel_header_grid_focus_ref = useRef(new Map<string, number>());
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
    // GridShell blurs the active element once a save is admitted. Remember that
    // the grid owned focus before that intentional blur so a later rejection can
    // hand keyboard focus to the worksheet it reveals. Keyed to the operation so
    // a stale terminal can never consume a newer save's intent.
    const pending_save_grid_focus_ref = useRef<{
        editSessionId: string;
        saveRequestId: string;
        pendingCell?: {
            readonly pendingRowId: string;
            readonly sourceColumn: number;
        };
        /** A cursor on a source cell, which a structural save renumbers. */
        sourceCell?: SourceCellFocus;
        restoreFocus: boolean;
    } | null>(null);
    /** The active grid's cursor on a source cell, with the sheet it is on. */
    const active_source_cell_focus = (): SourceCellFocus | undefined => {
        const cell = grid_focus_ref.current?.source_active_cell?.();
        return cell === undefined ? undefined : { ...cell, sheetIndex: active_sheet_index_for_focus_ref.current };
    };
    const saved_row_focus_sequence_ref = useRef(0);
    const pending_row_focus_sequence_ref = useRef(0);
    const save_projection_ref = useRef<CsvSaveProjection>(
        INITIAL_CSV_SAVE_PROJECTION,
    );
    const processed_save_receipts_ref = useRef(new Set<string>());
    const meta_ref = useRef<WorkbookMeta | null>(null);
    const pending_transform_request_ids_ref = useRef<(string | undefined)[]>([]);
    // Settled each time a transform of this window is answered or dropped, for a
    // replay that has to wait for every one of them before it asks for a session.
    const transform_settled_ref = useRef<PendingSignal<void> | null>(null);
    // Replays in `ensure_replay_session` waiting for those transforms.
    const replay_waiting_for_transforms_ref = useRef(0);
    const notify_transform_settled = useCallback(() => {
        const settled = transform_settled_ref.current;
        transform_settled_ref.current = null;
        settled?.settle();
    }, []);
    /**
     * One step of waiting until no transform of this window that `which`
     * names is pending: the host starts no editing session while one
     * installs. `'clear'`, said synchronously, means none is pending now, so
     * a caller that posts its request in the same step cannot be overtaken
     * by one; `'past-bound'` means the bound has passed and the request goes
     * to the host, which answers as it would have. Otherwise it waits for the
     * next transform to settle (or the bound) and says whether the document
     * was replaced meanwhile; the caller asks again.
     */
    const next_window_transform_wait = useCallback((
        which: (sheet_index: number) => boolean,
        deadline: number,
        document: number,
    ): 'clear' | 'past-bound' | Promise<'again' | 'replaced'> => {
        const pending = pending_transform_request_ids_ref.current
            .some((id, sheet_index) => id !== undefined && which(sheet_index));
        if (!pending) return 'clear';
        const remaining = deadline - Date.now();
        if (remaining <= 0) return 'past-bound';
        const settled = transform_settled_ref.current ?? pending_signal<void>();
        transform_settled_ref.current = settled;
        return (async () => {
            let timer: number | undefined;
            await Promise.race([
                settled.settled,
                new Promise<void>((resolve) => { timer = window.setTimeout(resolve, remaining); }),
            ]);
            window.clearTimeout(timer);
            return history_document_ref.current !== document ? 'replaced' : 'again';
        })();
    }, []);

    const pending_transform_states_ref = useRef<(SheetTransformState | undefined)[]>([]);
    const pending_transform_origins_ref = useRef<(TransformOrigin | undefined)[]>([]);
    /**
     * The view requests of this window awaiting the host's answer, by sheet
     * index: a sort, filter, or hide the person made, or a view step's replay.
     * Set where the request is posted and cleared wherever its pending request
     * id is cleared or replaced.
     */
    const pending_view_transforms_ref = useRef<(PendingViewTransform | undefined)[]>([]);
    /**
     * The person's sort, filter, and Unhide all choices on one sheet since its
     * last install, and every request sent for them (plan I1-I4). At most one in
     * a window: a choice on another sheet is refused while it is pending. It ends
     * when the host has settled every request it sent, which can be after the
     * install, so until then it counts as a view request in flight: an edit
     * recorded between the install and the settlement would enter history ahead
     * of the step the person made first.
     */
    const view_action_ref = useRef<PendingViewAction | undefined>(undefined);
    /**
     * Whether a sort or filter choice on a sheet waits: a request is pending
     * there that is not the person's own view action's, that is a hide, a
     * replay, or a restore. The action's own request does not hold a choice,
     * because a new choice replaces it.
     */
    const view_choice_waits = (sheet_index: number): boolean => {
        const request_id = pending_transform_request_ids_ref.current[sheet_index];
        if (request_id === undefined) return false;
        const pending = view_action_ref.current;
        return pending === undefined
            || pending.action.sheetIndex !== sheet_index
            || !view_action_owns(pending.action, request_id);
    };
    /** `publish_history_menu_state`, declared further down: the Edit menu names the action. */
    const publish_history_menu_ref = useRef<() => void>(() => {});
    /** `cancel_view_action_on_sheet` and `cancel_blocked`, which are declared further down. */
    const cancel_view_action_ref = useRef<(sheet_index: number) => boolean>(() => false);
    const cancel_blocked_ref = useRef<() => boolean>(() => true);
    const pending_column_write_ref = useRef<PendingColumnWrite | null>(null);
    const pending_width_write_ref = useRef<PendingWidthWrite | null>(null);
    /**
     * Whether a view request of this window is pending: the refs above and
     * the row-height requests a person made or a replay posted, read into
     * state so the grid stops offering an editor meanwhile. Never set on its
     * own; `sync_view_request_pending` is called at every site that sets or
     * clears one of them, so no exit can leave it up.
     *
     * A press of Undo or Redo that is waiting is not one, and is not shown
     * to the grid as one. The header queue's drain waits on this, and must
     * never wait on a held press; and the grid turns it into cells that
     * accept no edit, which the work a press waits for needs them to accept
     * (a claim resolves once the grid has rendered editable). A hold shown
     * as a view request would wait for the claim that waits for it.
     */
    const [view_request_pending, set_view_request_pending] = useState(false);
    const view_request_is_pending = useCallback((): boolean => {
        if (
            view_action_ref.current !== undefined
            || pending_view_transforms_ref.current.some((pending) => pending !== undefined)
            || pending_column_write_ref.current !== null
            || pending_width_write_ref.current !== null
        ) return true;
        // A row resize, reset, or row-height replay. The row a committed
        // edit grows is not one: it holds the edit gate, as it always has,
        // and not the cells' editors.
        for (const pending of pending_row_resize_requests_ref.current.values()) {
            if (pending.gesture || pending.replay !== undefined) return true;
        }
        return false;
    }, []);
    const sync_view_request_pending = useCallback(() => {
        set_view_request_pending(view_request_is_pending());
        // A request that settled renders only when the boolean changes; a
        // press held behind it is woken either way.
        wake_history_press();
    }, [view_request_is_pending, wake_history_press]);
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
    // Metadata is cloned into every host delivery, but formula topology changes
    // only when the adopted source changes. Key the compiled graph to that fact,
    // plus the document epoch that disambiguates a new file restarting counters.
    const header_formula_signature = (meta?.sheets ?? []).map((sheet) => [
        sheet.excelFirstRowHeader?.active === true,
        sheet.excelFirstRowHeader?.sourceRow ?? null,
        sheet.columnNames ?? null,
    ]);
    const pending_header_formula_signature = source_formula_edits.flatMap((edit) => {
        const sheet = meta?.sheets[edit.sheetIndex];
        const header_row = sheet?.excelFirstRowHeader?.sourceRow ?? 0;
        return sheet?.excelFirstRowHeader?.active === true && edit.row === header_row
            ? [[edit.sheetIndex, edit.column, edit.value]]
            : [];
    });
    const formula_graph_key = `${load_epoch}:${source_generation_ref.current}:`
        + JSON.stringify([
            header_formula_signature,
            pending_header_formula_signature,
            prospective_formula_row_counts,
        ]);
    const prospective_formula_sheets = useMemo(() => (meta?.sheets ?? []).map(
        (sheet, sheetIndex) => ({
            ...sheet,
            sourceRowCount: prospective_formula_row_counts[sheetIndex]
                ?? sheet.sourceRowCount,
        })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [formula_graph_key],
    );
    const workbook_formula_graph = useMemo(
        () => compile_workbook_formula_graph(prospective_formula_sheets),
        // Metadata is cloned between deliveries; this key names source topology.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [formula_graph_key],
    );
    // The worksheets Save will restructure: a live layout change on each.
    const restructured_sheets = useMemo(() => {
        if (!meta || !editing_session_held || structural_editing === undefined) return [];
        return meta.sheets.flatMap((sheet, sheetIndex) => {
            const changes = pending_structure.changes_for(sheetIndex);
            return changes !== undefined && has_live_layout_change(changes)
                ? [{ sheetIndex, name: sheet.name, changes }]
                : [];
        });
    }, [pending_structure, meta, structural_editing, editing_session_held]);
    // The Save button's description: what Save will do, per worksheet.
    const save_description = useMemo(() => {
        if (!meta || !editing_session_held) return undefined;
        return save_summary({
            singleTable: edit_syntax !== 'markdown',
            activeSheetIndex: active_sheet_index,
            worksheets: meta.sheets.map((sheet, sheetIndex) => {
                const changes = pending_structure.changes_for(sheetIndex);
                const cells = pending_cells.cells_for(sheetIndex);
                const header = sheet.excelFirstRowHeader;
                const renamed = header?.active === true && changes !== undefined
                    ? renamed_source_columns(sheet.columnNames, changes, (column) => {
                        const entry = cells.get(`${header.sourceRow ?? 0}:${column}`);
                        return entry === undefined ? undefined : committed_column_name(entry.value);
                    })
                    : 0;
                const note = changes === undefined
                    ? undefined
                    : short_rows_note(changes, structural_editing?.sheets[sheetIndex]?.shortestRowWidth);
                return {
                    sheetIndex,
                    name: sheet.name,
                    ...(changes === undefined ? {} : { counts: worksheet_structure_counts(changes, renamed) }),
                    cellEdits: cells.size === 0 ? 0 : saved_cell_edit_count(cells.keys(), changes, renamed),
                    ...(note === undefined ? {} : { note }),
                };
            }),
        });
    }, [meta, editing_session_held, edit_syntax, active_sheet_index, structural_editing,
        pending_structure, pending_cells]);
    const [cell_focus, set_cell_focus] = useState<CellFocus | null>(null);
    const cell_focus_sequence_ref = useRef(0);
    /** `handle_sheet_select`, defined below with the sheet tabs. */
    const handle_sheet_select_ref = useRef<(sheet_index: number) => unknown>(() => {});
    const [pending_change_notice_status, set_pending_change_notice_status] = useState('');
    // The Save warnings' formula question (ADR 0006): which formulas Save
    // will write #REF! into and which ranges a move or delete changed in a
    // way Excel might not. Asked without a click whenever the layouts or the
    // edits change, a moment after a burst of gestures settles, and only
    // while a worksheet has a layout change in a workbook that has formulas.
    // The key is the calculator's own.
    const workbook_has_formulas = (meta?.sheets ?? []).some((sheet) =>
        (sheet.formulaCells?.length ?? 0) > 0 || (sheet.pendingFormulaCells?.length ?? 0) > 0)
        || formula_calculation_edits.some((edit) => edit.writesFormula);
    const formula_review_key = edit_syntax === 'markdown'
        && prospective_formula_state !== undefined
        && restructured_sheets.length > 0
        && workbook_has_formulas
        ? `${load_epoch}:${source_generation_ref.current}:${formula_calculation_edit_signature}`
        : undefined;
    const formula_review = use_host_question({
        type: 'formulaDivergence',
        key: formula_review_key,
        delayMs: FORMULA_REVIEW_DELAY_MS,
        sourceGeneration: () => source_generation_ref.current,
        ask: (requestId, sourceGeneration) => ({
            type: 'requestFormulaDivergence',
            requestId,
            sourceGeneration,
            edits: formula_calculation_edits,
            layouts: prospective_formula_state!.layouts,
        }),
        read: (message): FormulaDivergenceReview | null => message.review,
    });
    /** A Save warning's Go to cell: select a formula's prospective cell, on its own sheet. */
    const go_to_prospective_cell = useCallback((sheet_index: number, row: number, column: number) => {
        const worksheet = formula_anchor_workbook?.worksheets[sheet_index];
        const cell = worksheet === undefined ? undefined : prospective_cell_at(worksheet, row, column);
        if (cell === undefined) {
            set_pending_change_notice_status('That cell is not available in the current view.');
            return;
        }
        set_pending_change_notice_status('');
        set_cell_focus({
            sequence: ++cell_focus_sequence_ref.current,
            sheetIndex: sheet_index,
            row: cell.row.kind === 'fixed' ? { kind: 'source', sourceRow: cell.row.sourceRow } : cell.row,
            column: cell.column,
        });
        if (sheet_index !== active_sheet_index) handle_sheet_select_ref.current(sheet_index);
    }, [active_sheet_index, formula_anchor_workbook]);
    const handle_cell_focus_applied = useCallback((sequence: number, visible: boolean) => {
        set_cell_focus((current) => current?.sequence === sequence ? null : current);
        if (!visible) set_pending_change_notice_status('That cell is not available in the current view.');
    }, []);
    const source_has_formula_work = (meta?.sheets ?? []).some((sheet) =>
        (sheet.formulaCells?.length ?? 0) > 0
        || (sheet.pendingFormulaCells?.length ?? 0) > 0
        || (sheet.formulaDependencies?.length ?? 0) > 0
        || (sheet.structuredFormulaReferences?.references.length ?? 0) > 0);
    const has_formula_work = source_has_formula_work
        || has_formula_moves
        || formula_calculation_edits.length > 0;
    const dependency_root_signature = has_formula_work
        ? formula_root_signature
        : 'no-formula-work';
    // Changing the text of an already-dirty cell keeps the same dependency
    // roots, so the common typing path avoids retraversing the graph.
    const dependency_formula_impact = useMemo(
        () => has_formula_moves
            ? all_workbook_formula_cells_impact(meta?.sheets ?? [])
            : too_many_formula_calculation_edits
            ? all_workbook_formula_cells_impact(meta?.sheets ?? [])
            : has_formula_work
                ? workbook_formula_graph.invalidatedBy(formula_roots)
                : all_workbook_formula_cells_impact([]),
        // The signatures deliberately stand in for cloned metadata and a mutable
        // edit array; topology and root coordinates are the only graph inputs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [workbook_formula_graph, dependency_root_signature, has_formula_moves],
    );
    const formula_calculation_key = `${formula_graph_key}:`
        + `${formula_calculation_edit_signature}`;
    const source_pending_formula_targets = useMemo(
        () => {
            const targets = new Map<string, FormulaCalculationAddress>();
            for (const target of pending_workbook_formula_targets(meta?.sheets ?? [])) {
                targets.set(`${target.sheetIndex}:${target.row}:${target.column}`, target);
            }
            (meta?.sheets ?? []).forEach((sheet, sheetIndex) => {
                const packed = sheet.structuredFormulaReferences?.references ?? [];
                for (
                    let offset = 0;
                    offset + STRUCTURED_REFERENCE_STRIDE - 1 < packed.length;
                    offset += STRUCTURED_REFERENCE_STRIDE
                ) {
                    const target = {
                        sheetIndex,
                        row: packed[offset],
                        column: packed[offset + 1],
                    };
                    targets.set(`${sheetIndex}:${target.row}:${target.column}`, target);
                }
            });
            return [...targets.values()];
        },
        // Pending source formulas move only with the adopted source topology.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [formula_graph_key],
    );
    const formula_calculation_plan = useMemo(() => {
        if (prospective_formula_state !== undefined) {
            // Formulas that name a restructured worksheet, and their
            // dependents and the edits' dependents, recalculate at their
            // prospective addresses; every other formula keeps its source
            // result.
            const layout_cells = layout_affected_formula_cells(
                prospective_formula_state.workbook,
                meta?.sheets ?? [],
            );
            const impact = workbook_impact_with_cells(
                workbook_formula_graph.invalidatedBy([
                    ...prospective_formula_state.graphRoots,
                    ...layout_cells,
                ]),
                layout_cells,
            );
            const planned = prospective_formula_targets(
                prospective_formula_state.workbook,
                impact,
                prospective_formula_state.editTargets,
            );
            const exceeded = too_many_formula_calculation_edits || planned.tooMany;
            return {
                sheetCount: meta?.sheets.length ?? 0,
                impact: exceeded ? all_workbook_formula_cells_impact(meta?.sheets ?? []) : impact,
                targets: exceeded ? [] : planned.targets,
                formulaLimitExceeded: exceeded,
            };
        }
        if (has_formula_moves) {
            return {
                sheetCount: meta?.sheets.length ?? 0,
                impact: dependency_formula_impact,
                targets: [],
                formulaLimitExceeded: false,
            };
        }
        if (too_many_formula_calculation_edits || !has_formula_work) {
            return {
                sheetCount: meta?.sheets.length ?? 0,
                impact: dependency_formula_impact,
                targets: [],
                formulaLimitExceeded: too_many_formula_calculation_edits,
            };
        }
        return plan_workbook_formula_recalculation(
            prospective_formula_sheets,
            formula_calculation_edits,
            { impact: dependency_formula_impact },
        );
    }, [
        dependency_formula_impact,
        formula_calculation_edits,
        formula_calculation_edit_signature,
        has_formula_work,
        has_formula_moves,
        meta?.sheets.length,
        prospective_formula_sheets,
        prospective_formula_state,
        too_many_formula_calculation_edits,
        workbook_formula_graph,
    ]);
    const formula_impact = formula_calculation_plan.impact;
    const formula_calculation_targets = formula_calculation_plan.targets;
    const [source_formula_calculation, set_source_formula_calculation] = useState<{
        readonly graphKey: string;
        readonly bySheet: readonly ReadonlyMap<string, string>[];
    }>();
    const [edit_formula_calculation, set_edit_formula_calculation] = useState<{
        readonly key: string;
        readonly bySheet: readonly ReadonlyMap<string, string>[];
    }>();
    useEffect(() => {
        set_source_formula_calculation((current) => current?.graphKey === formula_graph_key
            ? current
            : undefined);
        set_edit_formula_calculation(undefined);
    }, [formula_graph_key]);
    const source_formulas_ready = source_pending_formula_targets.length === 0
        || source_formula_calculation?.graphKey === formula_graph_key;
    const formula_calculation_sequence_ref = useRef(0);
    const active_formula_calculation_ref = useRef<{
        readonly requestId: string;
        readonly key: string;
        readonly kind: 'source' | 'edit';
    }>();
    useEffect(() => {
        const kind = source_formulas_ready ? 'edit' : 'source';
        const targets = kind === 'source'
            ? source_pending_formula_targets
            : formula_calculation_targets;
        const edits = kind === 'source' ? header_calculation_edits : formula_calculation_edits;
        if (targets.length === 0) {
            active_formula_calculation_ref.current = undefined;
            if (kind === 'edit') set_edit_formula_calculation(undefined);
            return;
        }
        formula_calculation_sequence_ref.current += 1;
        const requestId = `formula-calculation:${load_epoch}:`
            + `${formula_calculation_sequence_ref.current}`;
        const sourceGeneration = source_generation_ref.current;
        active_formula_calculation_ref.current = {
            requestId,
            key: kind === 'source' ? formula_graph_key : formula_calculation_key,
            kind,
        };
        host_bridge.postMessage({
            type: 'requestFormulaCalculation',
            requestId,
            sourceGeneration,
            edits,
            targets,
            // Source results are calculated at source addresses, without layouts.
            ...(kind === 'source' && prospective_formula_state !== undefined
                ? {}
                : {
                    prospectiveRowCounts: prospective_formula_row_counts,
                    removedRows: removed_formula_rows,
                }),
            ...(kind === 'edit' && prospective_formula_state !== undefined
                ? { layouts: prospective_formula_state.layouts }
                : {}),
        });
        return () => {
            if (active_formula_calculation_ref.current?.requestId === requestId) {
                host_bridge.postMessage({
                    type: 'cancelFormulaCalculation',
                    requestId,
                    sourceGeneration,
                });
                active_formula_calculation_ref.current = undefined;
            }
        };
    }, [
        formula_calculation_key,
        formula_calculation_targets,
        formula_calculation_edits,
        header_calculation_edits,
        load_epoch,
        prospective_formula_row_counts,
        prospective_formula_state,
        removed_formula_rows,
        source_formulas_ready,
        source_pending_formula_targets,
    ]);
    useEffect(() => {
        const on_message = (event: MessageEvent) => {
            const msg = event.data as HostMessage;
            if (msg.type !== 'formulaCalculation') return;
            const active = active_formula_calculation_ref.current;
            if (!active || active.requestId !== msg.requestId) return;
            if (msg.sourceGeneration !== source_generation_ref.current) return;
            const bySheet = (meta?.sheets ?? []).map(() => new Map<string, string>());
            for (const result of msg.results) {
                const sheet = bySheet[result.sheetIndex];
                if (!sheet) continue;
                sheet.set(`${result.row}:${result.column}`, displayed_formula_result(result));
            }
            if (active.kind === 'source') {
                set_source_formula_calculation({
                    graphKey: active.key,
                    bySheet,
                });
            } else {
                set_edit_formula_calculation({ key: active.key, bySheet });
            }
            if (active_formula_calculation_ref.current?.requestId === msg.requestId) {
                active_formula_calculation_ref.current = undefined;
            }
        };
        window.addEventListener('message', on_message);
        return () => window.removeEventListener('message', on_message);
    }, [formula_graph_key, meta?.sheets]);
    const active_source_formula_results = source_formula_calculation?.graphKey
        === formula_graph_key
        ? source_formula_calculation.bySheet[active_sheet_index]
        : undefined;
    const active_formula_results = edit_formula_calculation?.key === formula_calculation_key
        ? edit_formula_calculation.bySheet[active_sheet_index]
        : undefined;
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
    /**
     * Which document the workbook history belongs to, counted up each time a
     * different file replaces it and the history is cleared.
     *
     * Not `document_epoch_ref`, which moves on every applied snapshot. An undo
     * that has to acquire an editing session receives snapshots as part of the
     * grant, so a replay guarded by that epoch read its own session arriving as
     * the document leaving, and stopped without doing or saying anything.
     */
    const history_document_ref = useRef(0);
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
    /**
     * The highlight request awaiting the host, with the name to record it under.
     *
     * One ref and not two: the label is only ever read when a reply matching this
     * id arrives, so carrying it here makes "which gesture" and "what it was
     * called" impossible to get out of step.
     */
    const pending_highlight_request_ref = useRef<{
        readonly requestId: string;
        readonly label: string;
        readonly pendingGesture?: PendingHostGesture;
    } | null>(null);
    const row_resize_request_seq_ref = useRef(0);
    const pending_row_resize_requests_ref = useRef(new Map<string, PendingRowResize>());
    const last_highlight_state_revision_ref = useRef(0);

    const { persist_immediate } = use_state_sync(
        state_ref,
        source_generation_ref,
        snapshot_identity_ref,
    );

    /**
     * Publish each worksheet store's current truth — content or explicit null —
     * for the session, synchronously, and return the highest sequence produced.
     * Shared by the close/reload flush and by a Header Row change, which must
     * not post until the host holds everything the user sees. Leaves edit
     * admission alone; callers fence it as they need.
     */
    const publish_every_store_truth = (
        edit_session_id: string,
        // The close boundary re-sends an unacknowledged payload under a new
        // sequence; a header change only needs what changed since.
        resend_unacknowledged = true,
    ): number => {
        let highest = pending_changes_durability.snapshot(edit_session_id).highestProducedSequence;
        // The session is workbook-scoped: any sheet's store may hold edits
        // the host has not durably acknowledged, not just the sheet the
        // edit pointer names. Publish each store's current truth — content
        // or explicit null — so the host's slots match what the user sees
        // when the document comes back.
        const entries = new Map<string, {
            target: WorksheetTarget;
            cellStore?: ReturnType<EditSessionRegistry['for_sheet']>;
            pendingStore?: ReturnType<EditSessionRegistry['pending_rows_for_sheet']>;
            parked: boolean;
        }>();
        for (const { target, store, parked } of
            edit_session_registry_ref.current!.publication_entries(
                meta_ref.current?.sheets ?? [],
            )) {
            entries.set(worksheet_target_key(target), {
                target,
                cellStore: store,
                parked,
            });
        }
        for (const { target, store, parked } of
            edit_session_registry_ref.current!.pending_publication_entries(
                meta_ref.current?.sheets ?? [],
            )) {
            const key = worksheet_target_key(target);
            entries.set(key, {
                ...entries.get(key),
                target,
                pendingStore: store,
                parked: parked || entries.get(key)?.parked === true,
            });
        }
        for (const { target, cellStore, pendingStore, parked } of entries.values()) {
            const snapshot = cellStore?.snapshot() ?? new Map();
            const structural = pendingStore?.snapshot()
                ?? EMPTY_PENDING_STRUCTURAL_CHANGES;
            if (
                !parked
                && snapshot.size === 0
                && pending_rows(structural).length === 0
                && !pending_changes_carry_layout(structural)
                && structural.tailRemovals.length === 0
                && structural.conflicts.length === 0
                && !pending_changes_durability.has_publication(
                    edit_session_id,
                    target.sheetIndex,
                    target.sheetName,
                    target.worksheetId,
                )
            ) continue;
            highest = Math.max(
                highest,
                pending_changes_durability.publish(
                    edit_session_id,
                    Object.freeze({
                        ...target,
                        cells: Object.freeze(Object.fromEntries(snapshot)),
                        ...structural,
                    }),
                    source_generation_ref.current,
                    resend_unacknowledged && pending_changes_durability.has_unacknowledged_payload(
                        edit_session_id,
                        target.sheetIndex,
                        target.sheetName,
                        target.worksheetId,
                    ),
                ),
            );
        }
        return highest;
    };

    useLayoutEffect(() => install_pending_edit_flush_responder(async () => {
        const edit_session_id = csv_edit_session_id_ref.current;
        if (!edit_session_id) return { highestProducedSequence: 0 };

        // This is the document-lifetime close/reload boundary. Fence the mounted
        // grid synchronously, then fold its live overlay before sampling the
        // App-owned store that survives generation-keyed GridShell remounts.
        const editing = editing_ref.current;
        editing?.stop_edit_admission();
        // Under the publication fence nothing folded would reach the host, and
        // until the render after the fence rose closes it an open editor's
        // fold is refused like any edit: it is left as it is.
        if (
            !publication_fence.is_raised()
            && editing?.commit_live_edit_at_close_barrier() === false
        ) {
            throw new Error('The open cell edit exceeds the pending-changes limit.');
        }
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        const durability = pending_changes_durability.snapshot(edit_session_id);
        const publication_fenced = renderer_publication_fenced_session_ref.current
            === edit_session_id;
        let highest_produced_sequence = durability.highestProducedSequence;
        if (!save_in_flight_ref.current && !publication_fenced) {
            highest_produced_sequence = Math.max(
                highest_produced_sequence,
                publish_every_store_truth(edit_session_id),
            );
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
        // Given for a gesture that records a step and for a replay; a restore
        // and a cancel give none.
        view?: Omit<PendingViewTransform, 'requestId'>,
    ): string => {
        const request_id = [
            'transform',
            transform_request_prefix_ref.current,
            sheet_index,
            ++transform_request_seq_ref.current,
        ].join(':');
        pending_transform_request_ids_ref.current[sheet_index] = request_id;
        pending_transform_states_ref.current[sheet_index] = state;
        pending_transform_origins_ref.current[sheet_index] = origin;
        // Replaces whatever was pending on this sheet: a replaced gesture never
        // answers to this window and records nothing, and a replaced replay (a
        // cancel) leaves its entry where it was.
        pending_view_transforms_ref.current[sheet_index] = view === undefined
            ? undefined
            : { ...view, requestId: request_id };
        sync_view_request_pending();
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
        return request_id;
    }, [sync_view_request_pending]);

    /**
     * Send the view action's request again: a change made elsewhere moved its
     * baseline while its newest request was out, so it is composed onto the new
     * baseline, and this request supersedes the one in flight (I3).
     */
    const send_view_action_again = useCallback(() => {
        const pending = view_action_ref.current;
        if (pending === undefined) return;
        const { action } = pending;
        const request_id = request_transform(
            action.sheetIndex,
            action.requested,
            action.cancelled ? 'cancel' : 'user',
            'history',
            action.cancelled ? undefined : {
                worksheet: pending.worksheet,
                schema: pending.schema,
                baseline: action.baseline,
                target: action.requested,
            },
        );
        view_action_ref.current = { ...pending, action: resend_in_view_action(action, request_id) };
    }, [request_transform]);

    /**
     * The host settled one of the view action's requests. When it has settled
     * every one, the action records one step, from its baseline to what is
     * installed (I2), and a press waiting behind it is decided as today: dropped
     * with a message when the person's choice came to nothing because it was
     * refused or another window's change took its place, and let run otherwise.
     */
    const settle_view_action_answer = useCallback((
        msg: Extract<HostMessage, { type: 'transformSettled' }>,
    ) => {
        const pending = view_action_ref.current;
        if (pending === undefined || !view_action_owns(pending.action, msg.requestId)) return;
        const installed = msg.projection === undefined
            ? state_ref.current.transforms?.[msg.sheetIndex]
            : msg.projection.rules;
        const settlement = settle_view_action(pending.action, msg.requestId, installed, msg.committedBy);
        if (settlement.kind === 'pending') {
            view_action_ref.current = { ...pending, action: settlement.action };
            if (settlement.resend) send_view_action_again();
            return;
        }
        view_action_ref.current = undefined;
        perf_mark('tv:view-action-ended', { requestId: msg.requestId });
        const step = transform_view_step(
            pending.worksheet,
            pending.schema,
            settlement.baseline,
            settlement.installed,
        );
        record_view_step(step);
        sync_view_request_pending();
        publish_history_menu_ref.current();
        if (
            step === undefined
            && !pending.action.cancelled
            && (pending.refused
                || !transforms_semantically_equal(settlement.baseline, pending.initialBaseline))
        ) {
            drop_press_behind_unrecorded_gesture();
        }
    }, [drop_press_behind_unrecorded_gesture, record_view_step, send_view_action_again, sync_view_request_pending]);
    const settle_view_action_ref = useRef(settle_view_action_answer);
    settle_view_action_ref.current = settle_view_action_answer;

    /**
     * A snapshot on the same source was applied while the view action is
     * pending. Its durable rules for the action's sheet are this window's own
     * only when this panel's commit record names one of the action's requests
     * and wrote those very rules; any other change was made elsewhere and moves
     * the action's baseline (I3).
     */
    const refresh_view_action_after_snapshot = useCallback((snapshot: WorkbookSnapshot) => {
        const pending = view_action_ref.current;
        if (pending === undefined) return;
        const sheet_index = pending.action.sheetIndex;
        const durable = state_ref.current.transforms?.[sheet_index];
        const record = snapshot.transformCommits?.[sheet_index];
        const committed_by = record !== undefined
            && transforms_semantically_equal(record.rules, durable)
            ? record.requestId
            : undefined;
        // The compare toggle is session state and never durable: the snapshot's
        // rules carry the action's own.
        const rules = pending.action.baseline?.onlyChangedRows === true
            ? { ...(durable ?? { sort: [], filters: [] }), onlyChangedRows: true as const }
            : durable;
        const refreshed = refresh_view_action(pending.action, rules, committed_by);
        if (refreshed.action === pending.action) return;
        view_action_ref.current = { ...pending, action: refreshed.action };
        publish_history_menu_ref.current();
        if (refreshed.resend) send_view_action_again();
    }, [send_view_action_again]);
    const refresh_view_action_ref = useRef(refresh_view_action_after_snapshot);
    refresh_view_action_ref.current = refresh_view_action_after_snapshot;

    /** Drop a save verdict and any informational notice tied to that verdict. */
    const clear_save_verdict = useCallback(() => {
        set_save_rejection(null);
        set_dismissed_external_change_occurrences({});
        cancel_external_change_navigation();
        set_open_external_change_occurrence(null);
        set_external_change_navigation_status('');
    }, [cancel_external_change_navigation]);

    const fence_edit_session_exit = useCallback((edit_session_id: string) => {
        // Fence both the document-level final publication and every mounted-grid
        // publication before the terminal message can reach the host. Otherwise a
        // concurrent close flush can sample a sequence emitted after release began,
        // which the releasing host correctly refuses and therefore never acknowledges.
        renderer_publication_fenced_session_ref.current = edit_session_id;
        editing_ref.current?.stop_edit_admission();
    }, []);

    const release_edit_session = useCallback(() => {
        if (!csv_edit_session_id) return;
        fence_edit_session_exit(csv_edit_session_id);
        host_bridge.postMessage({
            type: 'releaseEditSession',
            editSessionId: csv_edit_session_id,
        });
    }, [csv_edit_session_id, fence_edit_session_exit]);

    const end_editing_session = useCallback(() => {
        set_editing_session_held(false);
        release_edit_session();
        // A verdict is scoped to an editing session. Ending the session ends the one
        // it belonged to, so nothing it named can still be pending.
        clear_save_verdict();
    }, [clear_save_verdict, release_edit_session]);

    const discard_edit_session = useCallback(() => {
        if (!csv_edit_session_id) return;
        // Nothing this window holds is sent, and a Discard is recorded: it
        // waits for the reopen like every other change.
        if (refused_for_reopen()) return;
        // A discard is a recorded gesture, so it answers to the same reservation
        // every other one does — and it does NOT reach `run_edit_gesture`, which is
        // where the rest of them are gated. Recorded across a highlight round trip
        // it would land ahead of the highlight the user made first, so the first
        // undo would repaint cells instead of restoring the discarded edits.
        //
        // Refused rather than deferred: the window is one host round trip, and a
        // discard queued behind a reply would fire after the user had moved on.
        //
        // Answered rather than silently dropped, because one caller is the save
        // dialog's "discard" choice: the dialog has already closed by the time this
        // runs, so a bare `return` would leave the user holding the session with their
        // edits intact and no account of why. The button caller is harmless either
        // way — it is visibly still there to press again.
        //
        // Named per reservation, because the two are separate waits and telling the
        // user the wrong one is worse than telling them nothing: a replay-busy
        // discard has no highlight anywhere in it.
        if (pending_highlight_request_ref.current !== null) {
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'A cell highlight is still being applied. Try discarding again in a moment.',
            });
            return;
        }
        if (pending_row_resize_requests_ref.current.size > 0) {
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'A row resize is still being applied. Try discarding again in a moment.',
            });
            return;
        }
        if (!edit_gestures_admitted()) {
            host_bridge.postMessage({
                type: 'showWarning',
                message: header_fence_ref.current
                    ? 'Wait for the header row change to finish, then discard.'
                    : 'An undo is still being applied. Try discarding again in a moment.',
            });
            return;
        }
        // Fold any open cell editor FIRST, so its text is part of what the discard
        // throws away and therefore part of what undoing it restores. Left open, it
        // would be dropped by the exit below with nothing in history describing it.
        if (editing_ref.current?.commit_live_edit() === false) return;
        // Emptying the stores and recording what was emptied are ONE transaction;
        // the invariant and its outcomes live in the model.
        const outcome = run_discard_transaction({
            registry: edit_session_registry_ref.current!,
            history: history_store_ref.current!,
            sessionId: csv_edit_session_id,
            sheets: meta_ref.current?.sheets ?? [],
        });
        // Nothing was emptied and nothing recorded, so the user presses it again —
        // which is why the fence comes AFTER this and not before. Fenced first,
        // this return would leave the session alive but its admission stopped and
        // its publication silenced: the user keeps the session and their edits,
        // unable to type, and nothing else lowers the fence for a session that is
        // never leaving.
        if (outcome.kind === 'abandoned') return;
        // Past the point of no return, and before the terminal message reaches the
        // host, which is the ordering the fence exists for.
        fence_edit_session_exit(csv_edit_session_id);
        if (outcome.kind === 'unrecordable') {
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'These edits were too large to keep in the undo history, so discarding them cannot be undone.',
            });
        }
        set_editing_session_held(false);
        // Every edit is being thrown away, including the rejected ones.
        clear_save_verdict();
        // Undo of this discard must wait for the host's cleanup: until it settles,
        // a request for the new session it needs would be refused for a reason
        // about timing rather than about the document.
        discard_cleanup_ref.current = {
            session: csv_edit_session_id,
            ...pending_signal<boolean>(),
        };
        host_bridge.postMessage({
            type: 'discardEditSession',
            editSessionId: csv_edit_session_id,
        });
    }, [clear_save_verdict, csv_edit_session_id, fence_edit_session_exit, refused_for_reopen]);

    const begin_save_operation = useCallback((): CsvSaveOperation | undefined => {
        // Both fences refuse before anything a Save starts (the notices
        // below), with a session or without one: nothing is asked of the file.
        // A window that no longer matches its file would save its own stores,
        // which disagree with it, over the file.
        if (reopen_required_ref.current) {
            // Once for a held Cmd+S, by `say_history`'s repeat rule.
            say_history(REOPEN_REQUIRED_SAVE_MESSAGE);
            return undefined;
        }
        // A Header Row change carries the session's Pending Changes to the new
        // header in its own durable write; Save waits until it has landed.
        if (header_fence_ref.current) {
            warn_save_waits_for_header();
            return undefined;
        }
        // A conflict notice's dismissal is occurrence-scoped: Save is the
        // user's explicit request to see whether the condition still blocks
        // persistence. Dismissed formula warnings stay dismissed.
        set_dismissed_notices((current) => [...current].some(is_conflict_dismissal)
            ? new Set([...current].filter((key) => !is_conflict_dismissal(key)))
            : current);
        if (!csv_edit_session_id || save_projection_ref.current.operation) return undefined;
        // And for a view change still being written. A size or column write
        // posted just before Save could be answered after a structural save
        // has renumbered rows and columns and cut history off, and its step
        // would be recorded in the numbering from before the save.
        if (view_request_is_pending()) {
            host_bridge.postMessage({ type: 'showWarning', message: VIEW_GESTURE_WAIT_MESSAGE });
            return undefined;
        }
        const sheets = meta_ref.current?.sheets ?? [];
        const preflight = edit_session_registry_ref.current!
            .collect_dirty_worksheets(sheets);
        if (preflight.status === 'blocked') {
            host_bridge.postMessage({
                type: 'showWarning',
                message: preflight.reason === 'unresolvedBases'
                    ? 'Load every edited row before saving so its current file value can be verified.'
                    : 'A worksheet containing unsaved edits was removed. Restore it or discard the workbook edit session before saving.',
            });
            return undefined;
        }
        if (preflight.worksheets.length === 0) return undefined;
        const worksheets = preflight.worksheets.map(({
            target,
            edits,
            dirtyEdits,
            structuralChanges,
        }) =>
            Object.freeze<CsvSaveWorksheetOperation>({
                ...target,
                edits,
                dirtyEdits,
                ...(structuralChanges === undefined ? {} : { structuralChanges }),
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
        const pending_cell = grid_focus_ref.current?.pending_active_cell?.();
        const restore_focus = grid_focus_ref.current?.has_focus() === true;
        const source_cell = active_source_cell_focus();
        pending_save_grid_focus_ref.current = pending_cell !== undefined || source_cell !== undefined
            || restore_focus
            ? {
                editSessionId: operation.editSessionId,
                saveRequestId: operation.saveRequestId,
                restoreFocus: restore_focus,
                ...(pending_cell === undefined ? {} : { pendingCell: pending_cell }),
                ...(source_cell === undefined ? {} : { sourceCell: source_cell }),
            }
            : null;
        set_save_operation(operation);
        save_in_flight_ref.current = true;
        host_bridge.postMessage({ type: 'saveCsv', operation });
        return operation;
    }, [csv_edit_session_id, say_history, view_request_is_pending, warn_save_waits_for_header]);

    const reset_save_projection = useCallback(() => {
        save_projection_ref.current = INITIAL_CSV_SAVE_PROJECTION;
        processed_save_receipts_ref.current.clear();
        pending_save_grid_focus_ref.current = null;
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
        pending_changes?: unknown,
    ) => {
        // Read the outgoing stamp before install overwrites it.
        const store = edit_session_registry_ref.current!.for_sheet(sheet_index);
        const previous_identity = store.identity();
        store.install({ session_id }, edits);
        const pending_store = edit_session_registry_ref.current!
            .pending_rows_for_sheet(sheet_index);
        const previous_pending_identity = pending_store.identity();
        if (
            pending_changes !== undefined
            || previous_pending_identity === null
            || previous_pending_identity.session_id !== session_id
        ) {
            pending_store.install({ session_id }, pending_changes);
        }
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
        // handler for a superseding result, end_editing_session/discard_edit_session for
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

        // A terminal that settles the local proposal lowers the document fence;
        // the owning grid's report is only the usual way it is heard. While the
        // user is on another worksheet there is no owning grid mounted, and a
        // failed save keeps the session, so App must lower the fence itself. A
        // mismatched terminal retains `next.operation`, however, and therefore
        // cannot release the still-live proposal's fence.
        if (
            next.authoritative.state !== 'active'
            && next.operation === undefined
        ) {
            save_in_flight_ref.current = false;
        }

        const current_session_id = csv_edit_session_id_ref.current;
        const hydrate_and_install = (
            operation: CsvSaveOperation,
            disposition: 'restore' | 'tombstone',
        ) => {
            const sheet_index_for = worksheet_target_lookup(meta_ref.current?.sheets ?? []);
            const resolved: [number, CsvSaveWorksheetOperation][] = [];
            const seen = new Set<number>();
            for (const worksheet of save_operation_worksheets(operation)) {
                const sheet_index = sheet_index_for(worksheet);
                if (sheet_index === undefined || seen.has(sheet_index)) return;
                seen.add(sheet_index);
                resolved.push([sheet_index, worksheet]);
            }
            const saved_cells: SavedHistoryCell[] = [];
            for (const [sheet_index, worksheet] of resolved) {
                const entries = edit_session_registry_ref.current!
                    .for_sheet(sheet_index).snapshot();
                const pending = entries.size > 0
                    ? Object.fromEntries(entries)
                    : undefined;
                const hydrated = disposition === 'restore'
                    ? worksheet.dirtyEdits
                    : remove_operation_owned_pending_edits(pending, worksheet);
                install_edit_session(hydrated, current_session_id, sheet_index);
                if (disposition === 'tombstone') {
                    const sheet = meta_ref.current?.sheets[sheet_index];
                    // One at a time: a save can write more cells than a
                    // spread may pass as arguments.
                    for (const cell of saved_history_cells(worksheet, {
                        sheetIndex: sheet_index,
                        sheetName: sheet?.name ?? worksheet.sheetName,
                        worksheetId: sheet?.worksheetId ?? worksheet.worksheetId,
                    }, hydrated)) saved_cells.push(cell);
                }
                if (disposition === 'tombstone' && worksheet.structuralChanges) {
                    const structural_store = edit_session_registry_ref.current!
                        .pending_rows_for_sheet(sheet_index);
                    const retained = remove_operation_owned_pending_structural_changes(
                        structural_store.snapshot(),
                        worksheet,
                    );
                    structural_store.install(
                        { session_id: current_session_id },
                        retained,
                    );
                }
            }
            // The overlays the save wrote are gone, and the file now holds what
            // they held. History still describes every one of those cells as a
            // difference from the file before the save, so it is re-expressed
            // over the saved content here, in the same step that drops them.
            // Without that, undo finds no overlay where it recorded one and
            // refuses.
            history_store_ref.current!.rebase_saved_cells(saved_cells);
        };
        if (incoming.state === 'active') {
            if (
                incoming.operation.editSessionId === current_session_id
                && csv_save_operations_equal(next.operation, incoming.operation)
            ) {
                hydrate_and_install(incoming.operation, 'restore');
            }
        } else if (incoming.state !== 'idle') {
            const settled_operation = previous.operation
                && terminal_csv_save_settles_operation(incoming, previous.operation)
                ? previous.operation
                : undefined;
            if (previous.operation && !settled_operation) {
                return { previous, next, changed: true };
            }
            if (incoming.state === 'failed') {
                if (
                    settled_operation
                    && save_lifecycle_correlation(incoming)?.editSessionId
                        === current_session_id
                ) {
                    // A malformed request lifecycle carries only a sanitized
                    // host identity. Prefer the renderer-owned proposal, but run
                    // it back through the recovery boundary too: a corrupted
                    // local payload must retain the store's valid dirty map rather
                    // than throw or install malformed state.
                    hydrate_and_install(settled_operation, 'restore');
                }
            } else if (
                current_session_id === undefined
                || incoming.operation.editSessionId === current_session_id
            ) {
                hydrate_and_install(incoming.operation, 'tombstone');
                set_csv_edit_session_id(undefined);
                set_edit_session_pending(false);
                set_editing_session_held(false);
            }
        }
        return { previous, next, changed: true };
    }, [install_edit_session, set_csv_edit_session_id, set_editing_session_held]);

    const apply_save_receipt = useCallback((
        operation: CsvSaveOperation,
        receipt: PendingChangesSaveReceipt,
        lifecycle_revision: number,
    ): boolean => {
        const file_id = last_applied_snapshot_ref.current?.authority.fileId ?? '';
        const receipt_key = JSON.stringify([
            file_id,
            lifecycle_revision,
            operation.editSessionId,
            operation.saveRequestId,
        ]);
        if (processed_save_receipts_ref.current.has(receipt_key)) return false;
        const mark_processed = () => {
            processed_save_receipts_ref.current.add(receipt_key);
            while (processed_save_receipts_ref.current.size > 128) {
                const oldest = processed_save_receipts_ref.current.values().next().value;
                if (oldest === undefined) break;
                processed_save_receipts_ref.current.delete(oldest);
            }
        };

        const sheets = meta_ref.current?.sheets ?? [];
        if (receipt_has_structure(receipt)) {
            // A save that inserted, deleted, or moved rows or columns renumbered
            // the source coordinates every recorded action names, so it
            // installs the workbook-wide `structural-save` barrier instead of
            // rekeying history, and neither its inserted nor its appended rows
            // feed cross-save undo (design "History" and "Receipt").
            history_store_ref.current!.install_structural_save_barrier();
            // Selection by identity: a cursor on a Pending Row lands on the
            // row it became, and a cursor on a source cell on the saved
            // coordinate the receipt maps it to.
            const pending_focus = pending_save_grid_focus_ref.current?.pendingCell;
            const placements = [
                ...receipt.appendedRows,
                ...(receipt.structure ?? []).flatMap((entry) => entry.insertedRows.map((row) => ({
                    ...entry,
                    pendingRowId: row.pendingRowId,
                    sourceRow: row.sourceRow,
                }))),
            ];
            const placed = pending_focus === undefined
                ? undefined
                : placements.find((candidate) => candidate.pendingRowId === pending_focus.pendingRowId);
            const placed_sheet = placed === undefined ? undefined : worksheet_target_index(sheets, placed);
            // A cursor on a source cell follows it to its saved coordinate.
            const source_focus = pending_save_grid_focus_ref.current?.sourceCell;
            const source_entry = source_focus === undefined
                ? undefined
                : receipt.structure?.find((candidate) =>
                    worksheet_target_index(sheets, candidate) === source_focus.sheetIndex);
            if (source_focus !== undefined && source_entry !== undefined && pending_focus === undefined) {
                const row = structure_row_mapper(source_entry)(source_focus.sourceRow);
                const column = source_focus.sourceColumn < source_entry.columnMap.length
                    ? source_entry.columnMap[source_focus.sourceColumn] ?? null
                    : source_focus.sourceColumn;
                if (row !== null && column !== null) {
                    set_saved_row_focus({
                        sequence: ++saved_row_focus_sequence_ref.current,
                        sheetIndex: source_focus.sheetIndex,
                        sourceRow: row,
                        sourceColumn: column,
                        restoreFocus: pending_save_grid_focus_ref.current?.restoreFocus === true,
                    });
                }
            }
            if (placed !== undefined && placed_sheet !== undefined && pending_focus !== undefined) {
                const entry = receipt.structure?.find((candidate) =>
                    worksheet_target_index(sheets, candidate) === placed_sheet);
                const column = entry === undefined || pending_focus.sourceColumn >= entry.columnMap.length
                    ? pending_focus.sourceColumn
                    : entry.columnMap[pending_focus.sourceColumn] ?? null;
                if (column !== null) {
                    set_saved_row_focus({
                        sequence: ++saved_row_focus_sequence_ref.current,
                        sheetIndex: placed_sheet,
                        sourceRow: placed.sourceRow,
                        sourceColumn: column,
                        restoreFocus: pending_save_grid_focus_ref.current?.restoreFocus === true,
                    });
                }
            }
            // Clear what the save wrote from each worksheet's structural store:
            // its saved Pending Rows, its tail removals, and, where the save
            // restructured it, its layouts, Pending Columns, and basis.
            for (const [sheet_index] of sheets.entries()) {
                const restructured = (receipt.structure ?? []).some((entry) =>
                    worksheet_target_index(sheets, entry) === sheet_index);
                const pending_ids = new Set(placements
                    .filter((assignment) => worksheet_target_index(sheets, assignment) === sheet_index)
                    .map((assignment) => assignment.pendingRowId));
                const removed_rows = new Set(receipt.removedSourceRows
                    .filter((removal) => worksheet_target_index(sheets, removal) === sheet_index)
                    .flatMap((removal) => removal.sourceRows));
                if (!restructured && pending_ids.size === 0 && removed_rows.size === 0) continue;
                edit_session_registry_ref.current!.pending_rows_for_sheet(sheet_index).clear_saved(
                    operation.editSessionId,
                    pending_ids,
                    removed_rows,
                    restructured,
                );
            }
            mark_processed();
            return true;
        }
        const operation_worksheets = save_operation_worksheets(operation);
        const saved_history_rows = receipt.appendedRows.flatMap((assignment) => {
            const sheet_index = worksheet_target_index(sheets, assignment);
            if (sheet_index === undefined) return [];
            const structural = edit_session_registry_ref.current!
                .pending_rows_for_sheet(sheet_index)
                .snapshot();
            const submitted = operation_worksheets.find(
                (worksheet) => worksheet_target_index(sheets, worksheet) === sheet_index,
            )?.structuralChanges;
            const row = appended_rows(structural).find(
                (candidate) => candidate.id === assignment.pendingRowId,
            ) ?? appended_rows(submitted).find(
                (candidate) => candidate.id === assignment.pendingRowId,
            );
            const format = row === undefined
                ? undefined
                : structural.formatTemplates.find(
                    (template) => template.id === row.formatTemplateId,
                )?.format ?? submitted?.formatTemplates.find(
                    (template) => template.id === row.formatTemplateId,
                )?.format;
            if (row === undefined || format === undefined) return [];
            return [{
                worksheet: {
                    sheetIndex: assignment.sheetIndex,
                    ...(assignment.sheetName === undefined
                        ? {}
                        : { sheetName: assignment.sheetName }),
                    ...(assignment.worksheetId === undefined
                        ? {}
                        : { worksheetId: assignment.worksheetId }),
                },
                pendingRowId: assignment.pendingRowId,
                sourceRow: assignment.sourceRow,
                savedFingerprint: assignment.savedFingerprint,
                savedRow: assignment.savedRow ?? {
                    cells: assignment.savedCells ?? row.cells,
                    format,
                    ...(row.viewerRowHeight === undefined
                        ? {}
                        : { viewerRowHeight: row.viewerRowHeight }),
                    ...(row.highlights === undefined
                        ? {}
                        : { highlights: row.highlights }),
                },
            }];
        });
        history_store_ref.current!.rekey_saved_rows(saved_history_rows);
        const committed_removals = receipt.removedSourceRows.flatMap((removed) => {
            const sheet_index = worksheet_target_index(sheets, removed);
            if (sheet_index === undefined) return [];
            const removed_rows = new Set(removed.sourceRows);
            const structural = edit_session_registry_ref.current!
                .pending_rows_for_sheet(sheet_index)
                .snapshot();
            const submitted = operation_worksheets.find(
                (worksheet) => worksheet_target_index(sheets, worksheet) === sheet_index,
            )?.structuralChanges;
            const removals = [
                ...structural.tailRemovals,
                ...(submitted?.tailRemovals ?? []),
            ];
            const seen = new Set<string>();
            return removals
                .filter((removal) => {
                    if (
                        !removed_rows.has(removal.sourceRow)
                        || seen.has(removal.appendHistoryId)
                    ) return false;
                    seen.add(removal.appendHistoryId);
                    return true;
                })
                .map((removal) => ({
                    worksheet: {
                        sheetIndex: removed.sheetIndex,
                        ...(removed.sheetName === undefined
                            ? {}
                            : { sheetName: removed.sheetName }),
                        ...(removed.worksheetId === undefined
                            ? {}
                            : { worksheetId: removed.worksheetId }),
                    },
                    removal,
                }));
        });
        history_store_ref.current!.rekey_saved_removals(committed_removals);
        const pending_focus = pending_save_grid_focus_ref.current?.pendingCell;
        if (pending_focus !== undefined) {
            const assignment = receipt.appendedRows.find(
                (candidate) => candidate.pendingRowId === pending_focus.pendingRowId,
            );
            const sheet_index = assignment === undefined
                ? undefined
                : worksheet_target_index(sheets, assignment);
            if (assignment !== undefined && sheet_index !== undefined) {
                set_saved_row_focus({
                    sequence: ++saved_row_focus_sequence_ref.current,
                    sheetIndex: sheet_index,
                    sourceRow: assignment.sourceRow,
                    sourceColumn: pending_focus.sourceColumn,
                    restoreFocus: pending_save_grid_focus_ref.current?.restoreFocus === true,
                });
            }
        }
        for (const [sheet_index] of sheets.entries()) {
            const pending_ids = new Set(
                receipt.appendedRows
                    .filter((assignment) => worksheet_target_index(
                        sheets,
                        assignment,
                    ) === sheet_index)
                    .map((assignment) => assignment.pendingRowId),
            );
            const removed_rows = new Set(
                receipt.removedSourceRows
                    .filter((removal) => worksheet_target_index(
                        sheets,
                        removal,
                    ) === sheet_index)
                    .flatMap((removal) => removal.sourceRows),
            );
            if (pending_ids.size === 0 && removed_rows.size === 0) continue;
            edit_session_registry_ref.current!.pending_rows_for_sheet(sheet_index).clear_saved(
                operation.editSessionId,
                pending_ids,
                removed_rows,
            );
        }

        mark_processed();
        return true;
    }, []);

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
                const pending_highlight = pending_highlight_request_ref.current;
                const matching_request = !!msg.requestId
                    && pending_highlight?.requestId === msg.requestId;
                if (matching_request) {
                    pending_highlight_request_ref.current = null;
                    set_highlight_request_pending(false);
                    wake_history_press();
                    if (!msg.error && msg.deltas !== undefined && pending_highlight !== null) {
                        if (pending_highlight.pendingGesture !== undefined) {
                            const committed = pending_highlight.pendingGesture.commit(
                                [...highlight_history_source(
                                    msg.deltas,
                                    meta_ref.current?.sheets ?? [],
                                )],
                                pending_highlight.label,
                            );
                            if (!committed) {
                                host_bridge.postMessage({
                                    type: 'showWarning',
                                    message: 'The pending-row half of the highlight could not be applied.',
                                });
                                // Nothing recorded: a press held behind it was for its step.
                                drop_press_behind_unrecorded_gesture();
                            }
                        } else {
                            record_highlight_gesture(msg.deltas, pending_highlight.label);
                        }
                    } else {
                        pending_highlight?.pendingGesture?.cancel();
                        // Nothing recorded: a press held behind it was for its step.
                        drop_press_behind_unrecorded_gesture();
                    }
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
                    // (A press held behind this window's own request was
                    // dropped above, where the request was matched.)
                } else {
                    set_highlight_status(msg.requestId ? 'Cell highlights updated.' : 'Cell highlights refreshed.');
                }
            }

            if (msg.type === 'rowHeightsChanged') {
                // No entry: the row a committed edit grew, which nothing
                // waits on, or a request a refresh of another source dropped.
                // Its layer, if one still stands, is retired like any other.
                const pending = pending_row_resize_requests_ref.current.get(msg.requestId);
                if (pending !== undefined) {
                    pending_row_resize_requests_ref.current.delete(msg.requestId);
                    unwatch_view_replay(msg.requestId);
                    sync_view_request_pending();
                }
                const applied = msg.applied
                    && (pending === undefined || msg.sourceGeneration === pending.sourceGeneration)
                    && msg.sourceGeneration === source_generation_ref.current;
                // Any answer retires the layer painted for this request. The
                // host delivers what is stored before it answers, so from
                // here the row shows the projection. A layer left standing
                // (a refused write, or one another window overtook before the
                // delivery was built) would mask the height a later undo
                // restores. Applied, the layers older than the request go
                // with it: the host settled their writes first, so one still
                // standing paints a height nothing holds.
                set_row_height_overlay((previous) => mapped_row_height_overlays(
                    previous,
                    (overlay) => {
                        const layers = row_height_layers_after_answer(
                            overlay.layers,
                            msg.requestId,
                            applied,
                        );
                        if (layers === overlay.layers) return overlay;
                        return layers.length === 0 ? undefined : { ...overlay, layers };
                    },
                ));
                if (pending === undefined) return;
                pending.finish?.(applied);
                if (pending.replay !== undefined && pending.worksheet !== undefined) {
                    const { replay, worksheet } = pending;
                    if (applied) {
                        land_view_replay(replay, worksheet, false);
                    } else if (!msg.applied && msg.refused === 'limit') {
                        // A rule, not a race, and one this window cannot
                        // predict: the step is skipped and moves on, so it
                        // never stands in the way of an older one.
                        land_view_replay(
                            { ...replay, skipped: [...replay.skipped, 'too-many-heights'] },
                            worksheet,
                            true,
                        );
                    } else if (!msg.applied && msg.refused === 'unresolved') {
                        refuse_history_press(view_replay_refusal_warning(
                            replay.direction,
                            replay.entry.action.label,
                            UNRESOLVED_SAVE_SIZE_REASON,
                        ));
                    } else {
                        // Not applied because the source it named had been
                        // replaced: tried again once that refresh is here.
                        hand_over_history_retry(replay.press, replay.entry, replay.posted_after);
                    }
                } else if (pending.gesture) {
                    // Whether the gesture recorded nothing it should have: not
                    // applied here (refused, or a refresh of another source
                    // overtook it), or its worksheet is gone. A write that
                    // changed nothing is no failure, and records nothing.
                    let unrecorded = !applied || pending.worksheet === undefined;
                    if (applied && msg.change !== undefined && pending.worksheet !== undefined) {
                        // The step is what the host says the write changed:
                        // which source rows, and what each held.
                        const sheets = meta_ref.current?.sheets ?? [];
                        const index = worksheet_target_index(sheets, pending.worksheet);
                        const sheet = index === undefined ? undefined : sheets[index];
                        unrecorded = sheet === undefined || index === undefined;
                        if (sheet !== undefined && index !== undefined) {
                            record_view_step(row_heights_view_step(
                                {
                                    sheetIndex: index,
                                    sheetName: sheet.name,
                                    ...(sheet.worksheetId === undefined
                                        ? {}
                                        : { worksheetId: sheet.worksheetId }),
                                },
                                msg.change,
                            ));
                        }
                    } else if (!msg.applied && msg.refused === 'unresolved') {
                        host_bridge.postMessage({
                            type: 'showWarning',
                            message: SIZE_WRITE_UNRESOLVED_MESSAGE,
                        });
                    }
                    if (unrecorded) {
                        // The person's own gesture recorded nothing: a press
                        // held behind it was for its step, and would otherwise
                        // undo the one under it (as with Cancel).
                        drop_press_behind_unrecorded_gesture();
                    }
                }
                // A refusal renders nothing; a queued header change waits on this.
                wake_header_drain();
            }

            if (msg.type === 'columnWidthsChanged') {
                const pending = pending_width_write_ref.current;
                if (pending === null || pending.requestId !== msg.requestId) return;
                // Applied under another source generation: a snapshot of that
                // source is on its way and settles it. (One that already
                // arrived has, and the write is not pending.)
                if (
                    msg.applied
                    && (msg.sourceGeneration !== pending.sourceGeneration
                        || msg.sourceGeneration !== source_generation_ref.current)
                ) return;
                pending_width_write_ref.current = null;
                unwatch_view_replay(pending.requestId);
                sync_view_request_pending();
                settle_width_write_ref.current(pending, msg.applied
                    ? { kind: 'applied', change: msg.change ?? [] }
                    : { kind: 'refused', unresolved: msg.refused === 'unresolved' });
                // A settled write renders nothing; a queued header change waits on it.
                wake_header_drain();
            }

            if (msg.type === 'columnVisibilityChanged') {
                const pending = pending_column_write_ref.current;
                if (pending === null || pending.requestId !== msg.requestId) return;
                // Applied under another source generation: a snapshot of that
                // source is on its way and decides. (One that already arrived
                // has settled this write, and it is not pending.)
                if (
                    msg.applied
                    && (msg.sourceGeneration !== pending.sourceGeneration
                        || msg.sourceGeneration !== source_generation_ref.current)
                ) return;
                pending_column_write_ref.current = null;
                sync_view_request_pending();
                settle_column_write(pending, msg.applied, 'answer');
                // A settled write renders nothing; a queued header change waits on it.
                wake_header_drain();
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
                        defaultCategorical: msg.defaultCategorical === true,
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
                const floor = replay_state_floor_ref.current;
                // One delivery at most is turned away, each time it is
                // retried: only one is out at a time, so another below the
                // floor means the host's material never reached the write.
                const below_replay_floor = floor !== null
                    && floor.fileId === snapshot.identity.authority.fileId
                    && snapshot.identity.stateRevision < floor.stateRevision
                    && (floor.rejected === undefined || floor.rejected === snapshot.identity.deliveryId);
                if (floor !== null) {
                    replay_state_floor_ref.current = below_replay_floor
                        ? { ...floor, rejected: snapshot.identity.deliveryId }
                        : null;
                }
                const disposition = below_replay_floor
                    ? 'stale'
                    : classify_snapshot(
                        snapshot.identity,
                        last_applied_snapshot_ref.current,
                    );
                if (cross_file_initial && disposition === 'applied') {
                    reset_save_projection();
                    pending_excel_header_ref.current = null;
                    pending_excel_header_grid_focus_ref.current.clear();
                    pending_excel_header_unhide_ref.current = false;
                    pending_excel_header_promote_ref.current = false;
                    set_pending_excel_header(null);
                    set_excel_header_status('');
                    // Header work owed to the previous file ends with it, and so
                    // does the fence it raised.
                    lower_header_fence_ref.current();
                    // A warning dismissed in one file says nothing about another.
                    set_dismissed_notices(new Set());
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
                let grid_focus_sheet_after_excel_header: number | undefined;
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
                    grid_focus_sheet_after_excel_header =
                        pending_excel_header_grid_focus_ref.current.get(result.requestId);
                    pending_excel_header_grid_focus_ref.current.delete(result.requestId);
                    pending_excel_header_ref.current = null;
                    pending_excel_header_unhide_ref.current = false;
                    pending_excel_header_promote_ref.current = false;
                    set_pending_excel_header(null);
                    const queue_verdict = header_result_handler_ref.current(
                        result,
                        snapshot.identity.deliveryId,
                    );
                    if (queue_verdict !== 'report') return;
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
                const pending_grid_focus_sheet_before_result =
                    pending_excel_header_grid_focus_ref.current.values().next().value;
                const grid_focus_intent_survived =
                    grid_focus_ref.current?.has_focus() === true
                    || !has_surviving_focus_target();
                process_command_result(snapshot.commandResult);
                const grid_focus_sheet_for_snapshot =
                    grid_focus_sheet_after_excel_header
                    ?? pending_grid_focus_sheet_before_result
                    ?? (cross_file_initial
                        ? undefined
                        : grid_focus_restore_ref.current?.sheet_index);

                if (disposition === 'applied') {
                    // Every applied snapshot is lifecycle-relevant, including the
                    // first snapshot for a newly selected file.
                    const applied_save_transition = save_transition!;
                    const session_held_before_snapshot = editing_session_held_ref.current;
                    const edit_session_before_snapshot = csv_edit_session_id_ref.current;
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
                    // predicate matches GridShell's remount key: an initial load,
                    // a generation change that cannot refresh in place, or the
                    // active sheet changing. A save over a natural view is the
                    // exception because its display rows keep their identities.
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
                    const save_refresh_keeps_grid_mounted =
                        snapshot.reason === 'save'
                        && sheet_views_ref.current[active_sheet_index]?.permuted === false;
                    const generation_remounts_the_grid =
                        !save_refresh_keeps_grid_mounted
                        && snapshot.generation !== generation_ref.current;
                    const remounts_the_grid =
                        snapshot.presentation === 'initial'
                        || generation_remounts_the_grid
                        || next_active_sheet_index !== active_sheet_index
                        || active_sheet_changed;
                    const pending_cell_before_remount = remounts_the_grid
                        ? grid_focus_ref.current?.pending_active_cell?.()
                        : undefined;
                    if (
                        snapshot.presentation === 'refresh'
                        && !active_sheet_changed
                        && pending_cell_before_remount !== undefined
                    ) {
                        set_pending_row_focus({
                            sequence: ++pending_row_focus_sequence_ref.current,
                            sheetIndex: next_active_sheet_index,
                            pendingRowId: pending_cell_before_remount.pendingRowId,
                            sourceColumn: pending_cell_before_remount.sourceColumn,
                            restoreFocus: grid_focus_ref.current?.has_focus() === true,
                        });
                    } else if (snapshot.presentation === 'initial') {
                        set_pending_row_focus(null);
                    }
                    // `fenced_empty_ok`: under an exiting session's fence these
                    // answer false with nothing open, which threw away a
                    // remounting snapshot that arrived during a release before
                    // it could clear the session. With a changed overlay that
                    // will not commit the snapshot still waits, as before.
                    if (active_sheet_changed) {
                        if (editing_ref.current?.flush_live_edit({ fenced_empty_ok: true }) === false) return;
                    } else if (remounts_the_grid) {
                        if (editing_ref.current?.commit_live_edit({ fenced_empty_ok: true }) === false) return;
                    }
                    // The basis a pending highlight request was sent against, read
                    // BEFORE this snapshot overwrites either — see the abandonment
                    // check below.
                    const pending_basis_physical_revision = snapshot_identity_ref
                        .current?.sourceBasis.physicalRevision;
                    const pending_basis_source_generation = source_generation_ref.current;
                    snapshot_identity_ref.current = snapshot.identity;
                    // Each sheet's predecessor, by worksheet ID when it has one:
                    // a reload can rename a worksheet whose history and drafts
                    // still address it by ID.
                    const previous_sheet_index_for = worksheet_target_lookup(previous_sheets);
                    const previous_sheet_for = (sheet: WorkbookMeta['sheets'][number], index: number) => {
                        const previous_index = previous_sheet_index_for({
                            sheetIndex: index,
                            sheetName: sheet.name,
                            ...(sheet.worksheetId === undefined
                                ? {}
                                : { worksheetId: sheet.worksheetId }),
                        });
                        return previous_index === undefined
                            ? undefined
                            : previous_sheets[previous_index];
                    };
                    const header_changed = new Set<number>();
                    snapshot.meta.sheets.forEach((sheet, index) => {
                        const previous = previous_sheet_for(sheet, index);
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
                    // A Header Row change carries what the session holds for its
                    // worksheet (the host moved the Pending Changes in the same
                    // write; the reconcile below adopts them). Composer drafts,
                    // held only here, follow whatever the snapshot's reason.
                    // History needs nothing: an entry is re-expressed for the
                    // current Header Row when it is replayed.
                    for (const index of header_changed) {
                        const sheet = snapshot.meta.sheets[index]!;
                        const previous = previous_sheet_for(sheet, index)!;
                        // Composer drafts are held under the sheet's schema, which
                        // names the columns; the columns themselves did not change.
                        const draft_key = worksheet_target_key({
                            sheetIndex: index,
                            sheetName: sheet.name,
                            worksheetId: sheet.worksheetId,
                        });
                        const draft = append_composer_drafts_ref.current.get(draft_key);
                        if (draft?.schema === transform_schema_for_sheet(previous)) {
                            append_composer_drafts_ref.current.set(draft_key, {
                                ...draft,
                                schema: transform_schema_for_sheet(sheet),
                            });
                        }
                    }
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
                    const hydration_projection = applied_save_transition.next;
                    const authoritative_operation =
                        'operation' in hydration_projection.authoritative
                            ? hydration_projection.authoritative.operation
                            : undefined;
                    const proposed_worksheets = save_operation_worksheets(
                        hydration_projection.operation,
                    );
                    const authoritative_worksheets = authoritative_operation
                        === hydration_projection.operation
                        ? proposed_worksheets
                        : save_operation_worksheets(authoritative_operation);
                    const sheet_index_for = worksheet_target_lookup(snapshot.meta.sheets);
                    const by_sheet_index = (
                        worksheets: readonly CsvSaveWorksheetOperation[],
                    ): ReadonlyMap<number, CsvSaveWorksheetOperation> => {
                        const indexed = new Map<number, CsvSaveWorksheetOperation>();
                        for (const worksheet of worksheets) {
                            const sheet_index = sheet_index_for(worksheet);
                            if (
                                sheet_index === undefined
                                || indexed.has(sheet_index)
                            ) return new Map();
                            indexed.set(sheet_index, worksheet);
                        }
                        return indexed;
                    };
                    const proposed_worksheet_by_sheet = by_sheet_index(proposed_worksheets);
                    const authoritative_worksheet_by_sheet = authoritative_worksheets
                        === proposed_worksheets
                        ? proposed_worksheet_by_sheet
                        : by_sheet_index(authoritative_worksheets);
                    const hydrate_snapshot_edits = (
                        sheet_index: number,
                        pending_edits: SheetPendingEditCells | undefined,
                    ) => resolve_csv_save_hydration_from_worksheets(
                        hydration_projection,
                        snapshot_edit_session_id,
                        pending_edits,
                        proposed_worksheet_by_sheet.get(sheet_index),
                        authoritative_worksheet_by_sheet.get(sheet_index),
                    );
                    const hydrate_snapshot_structural_changes = (
                        sheet_index: number,
                        pending_changes: ReturnType<typeof pending_changes_for_sheet>,
                    ) => resolve_csv_save_structural_hydration_from_worksheets(
                        hydration_projection,
                        snapshot_edit_session_id,
                        pending_changes,
                        proposed_worksheet_by_sheet.get(sheet_index),
                        authoritative_worksheet_by_sheet.get(sheet_index),
                    );
                    const refresh_edits_for_sheet = (sheet_index: number) => {
                        if (snapshot.presentation !== 'refresh') return undefined;
                        const sheet = snapshot.meta.sheets[sheet_index];
                        return hydrate_snapshot_edits(
                            sheet_index,
                            pending_edits_for_sheet(
                                refresh_authoritative_state?.pendingEdits,
                                sheet_index,
                                sheet?.name,
                                sheet?.worksheetId,
                            ),
                        );
                    };
                    const authoritative_refresh_edits_for_target = (
                        target: WorksheetTarget,
                    ): SheetPendingEditCells | undefined => {
                        if (snapshot.presentation !== 'refresh') return undefined;
                        const pending = refresh_authoritative_state?.pendingEdits;
                        const direct = pending_edits_for_sheet(
                            pending,
                            target.sheetIndex,
                            target.sheetName,
                            target.worksheetId,
                        );
                        if (direct !== undefined || !pending) return direct;

                        // Removed worksheets are retained as parked stores, and
                        // their durable slot may have moved away from the captured
                        // index. Search by identity rather than reading whichever
                        // live worksheet now occupies that position.
                        const identified_index = pending.findIndex((slot) => {
                            if (!slot) return false;
                            return slot.worksheetId !== undefined
                                ? target.worksheetId !== undefined
                                    && slot.worksheetId === target.worksheetId
                                : slot.sheetName !== undefined
                                    && slot.sheetName === target.sheetName;
                        });
                        return identified_index === -1
                            ? undefined
                            : pending_edits_for_sheet(
                                pending,
                                identified_index,
                                target.sheetName,
                                target.worksheetId,
                            );
                    };
                    const authoritative_refresh_changes_for_target = (
                        target: WorksheetTarget,
                    ) => {
                        if (snapshot.presentation !== 'refresh') return undefined;
                        const pending = refresh_authoritative_state?.pendingEdits;
                        const direct = pending_changes_for_sheet(
                            pending,
                            target.sheetIndex,
                            target.sheetName,
                            target.worksheetId,
                        );
                        if (direct !== undefined || !pending) return direct;
                        const identified_index = pending.findIndex((slot) => {
                            if (!slot) return false;
                            return slot.worksheetId !== undefined
                                ? target.worksheetId !== undefined
                                    && slot.worksheetId === target.worksheetId
                                : slot.sheetName !== undefined
                                    && slot.sheetName === target.sheetName;
                        });
                        return identified_index === -1
                            ? undefined
                            : pending_changes_for_sheet(
                                pending,
                                identified_index,
                                target.sheetName,
                                target.worksheetId,
                            );
                    };
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
                    let locally_retained_structural_sheet_indices: ReadonlySet<number> = new Set();
                    if (snapshot.presentation === 'initial') {
                        // These requests belong to the document that is leaving.
                        // Resolve every caller before clearing the maps so no
                        // stale admission can hold editing or structural history
                        // forever. Settlement is posted even before a result: the
                        // host serializes it behind admission, and a later grant
                        // is therefore explicitly rejected rather than leaked.
                        for (const [request_id, pending] of
                            pending_append_requests_ref.current) {
                            host_bridge.postMessage({
                                type: 'settleRowAdmission',
                                requestId: request_id,
                                editSessionId: pending.editSessionId,
                                accepted: false,
                            });
                            pending.resolve(undefined);
                        }
                        pending_append_requests_ref.current.clear();
                        set_append_request_pending(false);
                        for (const [request_id, pending] of
                            pending_saved_row_restorations_ref.current) {
                            host_bridge.postMessage({
                                type: 'settleRowAdmission',
                                requestId: request_id,
                                editSessionId: pending.editSessionId,
                                accepted: false,
                            });
                            pending.resolve(undefined);
                        }
                        pending_saved_row_restorations_ref.current.clear();
                        for (const pending of
                            pending_tail_removal_validations_ref.current.values()) {
                            pending.resolve(false);
                        }
                        pending_tail_removal_validations_ref.current.clear();
                        pending_row_replay_plan_ref.current?.settleRestorations.forEach(
                            (settle) => settle(false),
                        );
                        pending_row_replay_plan_ref.current = null;
                        pending_row_replay_busy_ref.current = false;
                        edit_session_registry_ref.current!.replace_document();
                        lower_reopen_fence();
                        // A different file is under the history now. Any
                        // surviving action would be the previous workbook's
                        // edits, waiting to be replayed through whatever
                        // worksheet identity happened to match here.
                        history_store_ref.current!.clear();
                        history_document_ref.current += 1;
                        // Every view request of the outgoing document is
                        // abandoned outright: nothing is compared, nothing is
                        // recorded into the new document's history, and a late
                        // answer finds no pending request.
                        pending_view_transforms_ref.current = [];
                        view_action_ref.current = undefined;
                        pending_column_write_ref.current = null;
                        pending_width_write_ref.current = null;
                        overtaken_view_requests_ref.current = { views: [], column: null, width: null };
                        // A press waiting, or waiting to be tried again, was
                        // for the history that has just gone. Nothing is said.
                        drop_history_presses();
                        // Gestures of the outgoing document may still end (a
                        // paste whose clipboard read is out survives the
                        // grid): their tickets are fenced off from this one's.
                        document_ticket_floor_ref.current = press_epoch_ref.current += 1;
                        unwatch_view_replay();
                        unsettled_admissions_ref.current.clear();
                        sync_view_request_pending();
                        // And any replay still in flight was planned against the
                        // document that just left. Its caller is awaiting an
                        // answer, so it is settled rather than dropped — a promise
                        // that never resolved would hold the reservation, and the
                        // user's undo, for the life of the window.
                        replay_coordinator_ref.current?.reset();
                        // The outgoing document's discard cleanup, if one was
                        // still unacknowledged. Settled as failed rather than
                        // dropped: an awaiter would otherwise hold for an
                        // acknowledgement that belongs to a file which has left.
                        // Unreachable today — the cleared history refuses a replay
                        // before it asks for a session — but that is another
                        // mechanism's doing, not this one's.
                        const discarding = discard_cleanup_ref.current;
                        if (discarding !== undefined) {
                            discard_cleanup_ref.current = undefined;
                            discarding.settle(false);
                        }
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
                                (target) => !!edit_session_id
                                    && pending_changes_durability
                                        .has_unacknowledged_structural_payload(
                                        edit_session_id,
                                        target.sheetIndex,
                                        target.sheetName,
                                        target.worksheetId,
                                    ),
                            );
                        locally_retained_sheet_indices =
                            reconciliation.locallyRetainedIndices;
                        locally_retained_structural_sheet_indices =
                            reconciliation.locallyRetainedStructuralIndices;

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
                                if (pending_changes_durability
                                    .has_unacknowledged_structural_payload(
                                        edit_session_id,
                                        target.sheetIndex,
                                        target.sheetName,
                                        target.worksheetId,
                                    )) continue;
                                const store_snapshot = store.snapshot();
                                const current_edits = store_snapshot.size > 0
                                    ? Object.fromEntries(store_snapshot)
                                    : null;
                                const authoritative_edits =
                                    authoritative_refresh_edits_for_target(target);
                                if (pending_edit_durability.unacknowledged_payload_matches(
                                    edit_session_id,
                                    authoritative_edits ?? null,
                                    current_edits,
                                    target.sheetIndex,
                                    target.sheetName,
                                    target.worksheetId,
                                )) continue;
                                pending_edit_durability.publish(
                                    edit_session_id,
                                    current_edits,
                                    target.sheetIndex,
                                    target.sheetName,
                                    true,
                                    target.worksheetId,
                                );
                            }
                            const cell_stores = new Map(
                                Array.from(
                                    edit_session_registry_ref.current!
                                        .publication_entries(next_sheets),
                                    (entry) => [worksheet_target_key(entry.target), entry.store],
                                ),
                            );
                            for (const { target, store } of
                                reconciliation.retryStructuralPublications) {
                                const cells = cell_stores.get(
                                    worksheet_target_key(target),
                                )?.snapshot();
                                const current_cells = Object.fromEntries(
                                    [...(cells ?? new Map())].map(([key, entry]) => [
                                        key,
                                        copy_dirty_entry(entry),
                                    ]),
                                );
                                const current: WorksheetPendingChanges = {
                                    ...target,
                                    cells: current_cells,
                                    ...store.snapshot(),
                                };
                                const slot = authoritative_refresh_changes_for_target(target);
                                const authoritative_cells = Object.fromEntries(
                                    Object.entries(slot?.cells ?? {}).map(([key, entry]) => [
                                        key,
                                        typeof entry === 'string'
                                            ? { value: entry, base: entry }
                                            : entry,
                                    ]),
                                );
                                const authoritative: WorksheetPendingChanges = {
                                    ...target,
                                    cells: authoritative_cells,
                                    formatTemplates: slot?.formatTemplates ?? [],
                                    appendedRows: pending_rows(slot),
                                    tailRemovals: slot?.tailRemovals ?? [],
                                    ...(slot?.appendBasis === undefined
                                        ? {}
                                        : { appendBasis: slot.appendBasis }),
                                    conflicts: slot?.conflicts ?? [],
                                    ...pending_layout_fields(slot),
                                };
                                if (pending_changes_durability
                                    .unacknowledged_structural_payload_matches(
                                        edit_session_id,
                                        authoritative,
                                        current,
                                    )) continue;
                                const published = pending_changes_durability
                                    .unacknowledged_structural_payload(
                                        edit_session_id,
                                        target.sheetIndex,
                                        target.sheetName,
                                        target.worksheetId,
                                    );
                                const unchanged = <T,>(now: T, then: T): boolean =>
                                    JSON.stringify(now) === JSON.stringify(then);
                                // Publications this renderer superseded before the
                                // host acknowledged them. The host writes them in
                                // order, so a refresh can carry one after a newer
                                // gesture left: that is the host behind, not a
                                // change the host made, and adopting it would revert
                                // the newer gesture and republish the old layout,
                                // which the next echo reverts again.
                                const superseded = pending_changes_durability
                                    .superseded_structural_payloads(
                                        edit_session_id,
                                        target.sheetIndex,
                                        target.sheetName,
                                        target.worksheetId,
                                    );
                                // Three-way, per field: keep a local change since the
                                // latest publication; otherwise take the host's value,
                                // unless it is an echo of a superseded publication.
                                const take = <T,>(pick: (changes: WorksheetPendingChanges) => T): T => {
                                    const now = pick(current);
                                    const then = pick(published!);
                                    const host = pick(authoritative);
                                    if (!unchanged(now, then)) return now;
                                    if (
                                        !same_json(host, then)
                                        && superseded.some((payload) => same_json(pick(payload), host))
                                    ) return now;
                                    return host;
                                };
                                const merged_append_basis = published === undefined
                                    ? undefined
                                    : take((changes) => changes.appendBasis);
                                const merged: WorksheetPendingChanges = published === undefined
                                    ? current
                                    : {
                                        ...target,
                                        cells: take((changes) => changes.cells),
                                        formatTemplates: take((changes) => changes.formatTemplates),
                                        appendedRows: take(pending_rows),
                                        tailRemovals: take((changes) => changes.tailRemovals),
                                        ...(merged_append_basis === undefined
                                            ? {}
                                            : { appendBasis: merged_append_basis }),
                                        conflicts: take((changes) => changes.conflicts),
                                        ...take(pending_layout_fields),
                                    };
                                const cell_store = cell_stores.get(worksheet_target_key(target));
                                try {
                                    assert_pending_changes_encoded_bound(merged);
                                } catch {
                                    host_bridge.postMessage({
                                        type: 'showWarning',
                                        message: 'Newer pending changes could not be merged because the worksheet reached its size limit.',
                                    });
                                    continue;
                                }
                                const current_structural = store.snapshot();
                                const cell_writes: StoreWrite[] = [];
                                if (cell_store !== undefined) {
                                    const keys = new Set([
                                        ...cell_store.snapshot().keys(),
                                        ...Object.keys(merged.cells),
                                    ]);
                                    for (const key of keys) {
                                        cell_writes.push({ key, entry: merged.cells[key] });
                                    }
                                }
                                const cell_stage = cell_store?.stage_writes(
                                    edit_session_id,
                                    cell_writes,
                                    true,
                                );
                                const structural_stage = store.stage_replace(
                                    edit_session_id,
                                    current_structural,
                                    merged,
                                    true,
                                );
                                if (
                                    (cell_store !== undefined && cell_stage === undefined)
                                    || structural_stage === undefined
                                ) continue;
                                const stages: StagedMutation[] = [structural_stage];
                                if (cell_stage !== undefined) stages.unshift(cell_stage);
                                if (!commit_staged_transaction(stages)) continue;
                                if (unchanged(merged, authoritative)) continue;
                                pending_changes_durability.publish(
                                    edit_session_id,
                                    merged,
                                    snapshot.sourceGeneration,
                                    true,
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
                        && editing_session_held_ref.current
                        && csv_edit_session_id_ref.current === snapshot_edit_session_id
                        && (!pointer_deleted || pending_edit_sheet_index !== undefined);
                    if (pointer_deleted && pending_edit_sheet_index === undefined) {
                        editing_session_held_ref.current = false;
                        set_editing_session_held(false);
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
                        for (const { target, parked } of edit_session_registry_ref.current!
                            .pending_publication_entries(next_sheets)) {
                            if (!parked) refresh_sheet_indices.add(target.sheetIndex);
                        }
                        refresh_authoritative_state?.pendingEdits?.forEach(
                            (slot, index) => {
                                if (slot !== undefined) refresh_sheet_indices.add(index);
                            },
                        );
                        for (const sheet_index of refresh_sheet_indices) {
                            if (!locally_retained_sheet_indices.has(sheet_index)) {
                                edit_session_registry_ref.current!
                                    .for_sheet(sheet_index)
                                    .reconcile(
                                        { session_id: snapshot_edit_session_id },
                                        refresh_edits_for_sheet(sheet_index),
                                    );
                            }
                            if (!locally_retained_structural_sheet_indices.has(sheet_index)) {
                                const sheet = next_sheets[sheet_index];
                                const slot = hydrate_snapshot_structural_changes(
                                    sheet_index,
                                    pending_changes_for_sheet(
                                        refresh_authoritative_state?.pendingEdits,
                                        sheet_index,
                                        sheet?.name,
                                        sheet?.worksheetId,
                                    ),
                                );
                                edit_session_registry_ref.current!
                                    .pending_rows_for_sheet(sheet_index)
                                    .reconcile(
                                        { session_id: snapshot_edit_session_id },
                                        slot,
                                    );
                            }
                        }
                    }
                    document_epoch_ref.current += 1;
                    set_grid_focus_restore(
                        grid_focus_intent_survived
                            && grid_focus_sheet_for_snapshot === next_active_sheet_index
                            ? {
                                sheet_index: next_active_sheet_index,
                                generation: snapshot.generation,
                                document_epoch: document_epoch_ref.current,
                            }
                            : null,
                    );
                    set_toolbar_focus_restore(null);
                    diff_on_by_default_ref.current = snapshot.configuration.diffOnByDefault;
                    if (snapshot.presentation === 'initial') {
                        set_diff_mode(snapshot.configuration.diffOnByDefault);
                        set_saved_row_focus(null);
                        diff_mode_initialized_ref.current = false;
                        grid_scroll_positions_ref.current = new Map();
                        last_preview_visible_row_ref.current = null;
                        clear_pending_preview_scroll();
                    } else {
                        const retained_scroll_positions = new Map<string, ScrollPosition>();
                        snapshot.meta.sheets.forEach((sheet, sheet_index) => {
                            const key = worksheet_target_key({
                                sheetIndex: sheet_index,
                                sheetName: sheet.name,
                                worksheetId: sheet.worksheetId,
                            });
                            const position = grid_scroll_positions_ref.current.get(key);
                            if (position) retained_scroll_positions.set(key, position);
                        });
                        grid_scroll_positions_ref.current = retained_scroll_positions;
                        if (
                            preview_mode_ref.current
                            && pending_preview_scroll_ref.current === null
                            && last_preview_visible_row_ref.current !== null
                        ) {
                            queue_preview_scroll(last_preview_visible_row_ref.current);
                        }
                    }
                    preview_mode_ref.current = snapshot.configuration.previewMode;
                    set_preview_mode(snapshot.configuration.previewMode);
                    set_git_compare(snapshot.configuration.gitCompare);
                    // Deliberately NOT the end of a resolve: a snapshot says
                    // what the panel shows, and an unrelated refresh can land
                    // mid-download. Only the matching `lfsResolveEnded` clears
                    // `lfs_resolving`.
                    set_unresolved_lfs(snapshot.configuration.unresolvedLfs);
                    meta_ref.current = snapshot.meta;
                    set_meta(snapshot.meta);
                    const source_changed =
                        snapshot.presentation === 'initial'
                        || source_generation_ref.current !== snapshot.sourceGeneration;
                    // An open filter editor names a column of the active
                    // worksheet by position, so it ends when that position can
                    // mean another column: another document, another worksheet,
                    // or a change of the worksheet's columns (the rule that drops
                    // installed filters, and the one the Columns menu closes by).
                    // It also ends at new file contents when the column has no
                    // name of its own to say it is still the one: columns with
                    // no header, or sharing a name, can trade places in a save
                    // or a rewrite and leave the schema as it was.
                    // Any other snapshot leaves it open with what the person has
                    // typed. One always follows "Filter…" in a header menu: the
                    // menu acquired an editing session, and its idle release is
                    // delivered as a snapshot a moment after the editor opens.
                    const filter_editor_columns_changed =
                        snapshot.presentation === 'initial'
                        || next_active_sheet_index !== active_sheet_index
                        || active_sheet_changed
                        || previous_active_sheet === undefined
                        || next_active_sheet === undefined
                        || transform_schema_for_sheet(previous_active_sheet)
                            !== transform_schema_for_sheet(next_active_sheet);
                    const reloaded_column_names = source_changed
                        ? next_active_sheet?.columnNames ?? []
                        : undefined;
                    const filter_editor_after_snapshot = <Editor extends { column_index: number }>(
                        editor: Editor | null,
                    ): Editor | null => {
                        if (editor === null || filter_editor_columns_changed) return null;
                        if (reloaded_column_names === undefined) return editor;
                        const name = reloaded_column_names[editor.column_index];
                        return name !== undefined
                            && name !== ''
                            && reloaded_column_names.indexOf(name)
                                === reloaded_column_names.lastIndexOf(name)
                            ? editor
                            : null;
                    };
                    // Closing it here unmounts the control that held focus,
                    // with nobody to hand focus back as a dismissal does.
                    const filter_editor_shown = filter_editor_ref.current;
                    if (
                        filter_editor_shown !== null
                        && filter_editor_after_snapshot(filter_editor_shown) === null
                    ) {
                        filter_editor_closed_by_refresh_ref.current = filter_editor_shown.origin;
                    }
                    set_filter_editor(filter_editor_after_snapshot);
                    if (source_changed) {
                        histogram_cache_ref.current.clear();
                        set_filter_histogram({ key: '', value: { status: 'loading' } });
                    }
                    const view_generation_changed =
                        generation_ref.current !== snapshot.generation;
                    if (view_generation_changed && !save_refresh_keeps_grid_mounted) {
                        set_grid_mount_epoch((epoch) => epoch + 1);
                    }
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
                        set_highlight_status('');
                        set_highlight_selection_available(false);
                        set_edit_session_pending(false);
                        pending_edit_request_ref.current = null;
                        // The document the request was made against is gone, so
                        // nothing will answer it: a gesture waiting on the grant
                        // is told no rather than left waiting.
                        const waiting_grant = session_grant_ref.current;
                        session_grant_ref.current = undefined;
                        waiting_grant?.settle(false);
                        // The document is being replaced, which clears history with
                        // it: every part of a replay cursor destination describes a
                        // workbook that is no longer loaded.
                        history_focus_ref.current = null;
                        set_history_focus(null);
                        deferred_history_grid_focus_ref.current = null;
                    }
                    // A highlight request names the basis it was sent against, and
                    // its reply is filtered on that basis matching the live one — so
                    // once this snapshot moves either, no reply can ever resolve the
                    // request. Abandoning it is the only outcome left, and it must
                    // not be limited to the 'initial' case: an external file change
                    // arrives as a REFRESH with a new physical revision, and a
                    // request stranded there would hold both the highlight panel and
                    // — since the same reservation orders cell gestures against the
                    // history — every subsequent cell edit, for the life of the
                    // window.
                    if (
                        pending_highlight_request_ref.current !== null
                        && (
                            snapshot.presentation === 'initial'
                            || snapshot.identity.sourceBasis.physicalRevision
                                !== pending_basis_physical_revision
                            || snapshot.sourceGeneration !== pending_basis_source_generation
                        )
                    ) {
                        pending_highlight_request_ref.current.pendingGesture?.cancel();
                        pending_highlight_request_ref.current = null;
                        set_highlight_request_pending(false);
                        // Nothing recorded for the person's own gesture: a press held behind it
                        // was for its step, and would otherwise undo the one under it (as with Cancel).
                        drop_press_behind_unrecorded_gesture();
                        wake_history_press();
                    }
                    for (const [request_id, pending] of pending_row_resize_requests_ref.current) {
                        if (
                            snapshot.presentation !== 'initial'
                            && pending.sourceGeneration === snapshot.sourceGeneration
                        ) continue;
                        pending_row_resize_requests_ref.current.delete(request_id);
                        unwatch_view_replay(request_id);
                        pending.finish?.(false);
                        if (pending.gesture) {
                            // Nothing recorded for the person's own gesture: a press held behind it
                            // was for its step, and would otherwise undo the one under it (as with Cancel).
                            drop_press_behind_unrecorded_gesture();
                        }
                        // This window holds no durable heights, so the refresh
                        // cannot say whether the write landed. A gesture
                        // records nothing. A replay's entry stays, and
                        // pressing again is right either way: it writes from
                        // the step, not from a comparison.
                        if (pending.replay !== undefined && snapshot.presentation !== 'initial') {
                            // This snapshot is the refresh the replay lost
                            // to. It is counted further down, and the drain,
                            // which runs after this handler, reads it there.
                            hand_over_history_retry(
                                pending.replay.press,
                                pending.replay.entry,
                                pending.replay.posted_after,
                            );
                        }
                    }
                    // A pending width write: a refresh of another source
                    // overtook it; a refresh of the same source has adopted
                    // widths while it was pending, which its answer needs to
                    // know.
                    const pending_width_write = pending_width_write_ref.current;
                    if (pending_width_write !== null) {
                        if (pending_width_write.sourceGeneration !== snapshot.sourceGeneration) {
                            pending_width_write_ref.current = null;
                            unwatch_view_replay(pending_width_write.requestId);
                            overtaken_view_requests_ref.current.width = pending_width_write;
                        } else if (snapshot.presentation !== 'initial') {
                            pending_width_write.snapshotAdopted = true;
                        }
                    }
                    sync_view_request_pending();
                    // A pending column write: a refresh of another source
                    // generation overtook it and decides whether it landed
                    // (settled below, once the snapshot's state is adopted); a
                    // refresh of the same source has adopted column visibility
                    // while it was pending, which its answer needs to know.
                    const pending_column_write = pending_column_write_ref.current;
                    if (pending_column_write !== null) {
                        if (pending_column_write.sourceGeneration !== snapshot.sourceGeneration) {
                            pending_column_write_ref.current = null;
                            overtaken_view_requests_ref.current.column = pending_column_write;
                            sync_view_request_pending();
                        } else if (snapshot.presentation !== 'initial') {
                            pending_column_write.snapshotAdopted = true;
                        }
                    }
                    set_source_epoch((n) => n + 1);
                    // What the rows *are* changes with a new source, a new view
                    // generation (durable transform reconciliation bumps the
                    // generation without the source, and reports it only here), or a
                    // changed header row — and with nothing else. A same-generation
                    // capability refresh, which a session grant and every
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
                        pending_auto_fit_snapshot_ref.current = [];
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
                        invalid_auto_fit_sheets.forEach((index) => {
                            pending_auto_fit_snapshot_ref.current[index] = undefined;
                        });
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
                        // Not for a sheet whose widths this window is writing:
                        // a refresh captured before that commit differs by
                        // construction, and the delivery behind it carries the
                        // written widths. The write's settlement applies this
                        // rule to those sheets (`settle_width_write`).
                        const written_sheets = new Set(
                            (pending_width_write_ref.current?.sheets ?? []).flatMap((sheet) => {
                                const index = worksheet_target_index(
                                    snapshot.meta.sheets,
                                    sheet.worksheet,
                                );
                                return index === undefined ? [] : [index];
                            }),
                        );
                        const changed_widths = Array.from(
                            { length: width_count },
                            (_unused, index) => !written_sheets.has(index)
                                && !sheet_widths_equal(
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
                            stale.forEach((was_stale, index) => {
                                if (was_stale) pending_auto_fit_snapshot_ref.current[index] = undefined;
                            });
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
                        // The view action's request is kept on the same source: the
                        // host still computes it, and only a new source or receiver
                        // stops it (I3, `panel-core.ts` handle_set_transform). The
                        // action decides on this snapshot once it is applied.
                        if (source_changed && view_action_ref.current !== undefined) {
                            view_action_ref.current = undefined;
                            publish_history_menu_ref.current();
                        }
                        const kept_sheet = view_action_ref.current?.action.sheetIndex;
                        const kept = kept_sheet === undefined ? undefined : {
                            id: pending_transform_request_ids_ref.current[kept_sheet],
                            state: pending_transform_states_ref.current[kept_sheet],
                            origin: pending_transform_origins_ref.current[kept_sheet],
                            view: pending_view_transforms_ref.current[kept_sheet],
                        };
                        const keep = <T,>(values: T[], value: T | undefined): T[] => {
                            if (kept_sheet === undefined || value === undefined) return [];
                            const next: T[] = [];
                            next[kept_sheet] = value;
                            return next;
                        };
                        set_pending_transforms(keep([], kept?.id === undefined ? undefined : true));
                        set_pending_transform_labels((previous) => keep(
                            [],
                            kept?.id === undefined || kept_sheet === undefined ? undefined : previous[kept_sheet],
                        ));
                        pending_transform_request_ids_ref.current = keep([], kept?.id);
                        pending_transform_states_ref.current = keep([], kept?.state);
                        pending_transform_origins_ref.current = keep([], kept?.origin);
                        notify_transform_settled();
                        // The view requests dropped with them are settled below
                        // by what this snapshot shows.
                        overtaken_view_requests_ref.current.views.push(
                            ...pending_view_transforms_ref.current.filter(
                                (pending): pending is PendingViewTransform => (
                                    pending !== undefined && pending !== kept?.view
                                ),
                            ),
                        );
                        pending_view_transforms_ref.current = keep([], kept?.view);
                        sync_view_request_pending();
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
                        note_grid_replaced();
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
                        note_grid_replaced(normalized.activeSheetIndex);
                        set_active_sheet_index(normalized.activeSheetIndex);
                        set_column_widths(normalized.columnWidths);
                        set_show_formatting_by_sheet(normalized.showFormatting ?? []);
                        // Header work owed to the *previous* document is keyed by bare
                        // sheet index, so it cannot cross this boundary. Pending auto-fit
                        // was already cleared with the changed row basis above.
                        lower_header_fence_ref.current();
                        set_column_visibility(normalized.columnVisibility);
                        set_transforms(normalized.transforms);
                        const tab_orient = normalized.tabOrientation;
                        set_vertical_tabs(
                            tab_orient !== null
                                ? tab_orient === 'vertical'
                                : snapshot.configuration.defaultTabOrientation === 'vertical',
                        );
                        state_ref.current = normalized;
                        const restored_sheet =
                            snapshot.meta.sheets[snapshot_edit_sheet_index];
                        const restored_edits = hydrate_snapshot_edits(
                            snapshot_edit_sheet_index,
                            pending_edits_for_sheet(
                                normalized.pendingEdits,
                                snapshot_edit_sheet_index,
                                restored_sheet?.name,
                                restored_sheet?.worksheetId,
                            ),
                        );
                        const restored_pending_changes = hydrate_snapshot_structural_changes(
                            snapshot_edit_sheet_index,
                            pending_changes_for_sheet(
                                normalized.pendingEdits,
                                snapshot_edit_sheet_index,
                                restored_sheet?.name,
                                restored_sheet?.worksheetId,
                            ),
                        );
                        const restored_has_structural_changes =
                            (restored_pending_changes?.formatTemplates?.length ?? 0) > 0
                            || pending_rows(restored_pending_changes).length > 0
                            || pending_changes_carry_layout(restored_pending_changes)
                            || (restored_pending_changes?.tailRemovals?.length ?? 0) > 0
                            || restored_pending_changes?.appendBasis !== undefined
                            || (restored_pending_changes?.conflicts?.length ?? 0) > 0;
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
                            snapshot_edit_sheet_index,
                            restored_pending_changes,
                        );
                        // The session covers the whole workbook, so restored
                        // cells and structural changes can sit in any sheet's
                        // slot, not just the pointer sheet's. Seed both sibling
                        // stores, including structural-only slots.
                        normalized.pendingEdits?.forEach((_slot, index) => {
                            if (index === snapshot_edit_sheet_index) return;
                            const sheet = snapshot.meta.sheets[index];
                            const cells = hydrate_snapshot_edits(
                                index,
                                pending_edits_for_sheet(
                                    normalized.pendingEdits,
                                    index,
                                    sheet?.name,
                                    sheet?.worksheetId,
                                ),
                            );
                            const changes = hydrate_snapshot_structural_changes(
                                index,
                                pending_changes_for_sheet(
                                    normalized.pendingEdits,
                                    index,
                                    sheet?.name,
                                    sheet?.worksheetId,
                                ),
                            );
                            if (!cells && changes === undefined) return;
                            edit_session_registry_ref.current!
                                .for_sheet(index)
                                .install(
                                    { session_id: snapshot_edit_session_id },
                                    cells,
                                );
                            edit_session_registry_ref.current!
                                .pending_rows_for_sheet(index)
                                .install(
                                    { session_id: snapshot_edit_session_id },
                                    changes,
                                );
                        });
                        const holds_session = owns_clean_or_dirty_session
                            || restored_edits !== undefined
                            || restored_has_structural_changes;
                        diff_mode_initialized_ref.current = holds_session;
                        set_editing_session_held(holds_session);
                        set_editing_status(null);
                        set_editing_status_sheet_index(null);
                        // A fresh document: the rejection and the dismissal go
                        // together. The install above deliberately does not clear the
                        // verdict (a same-session refresh reinstalls the very map the
                        // host judged), so this is the clear for the reset — and it
                        // was already written to stand on its own rather than depend
                        // on that call's internals.
                        clear_save_verdict();
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
                        // The choice is stored for the file, so another window
                        // on it can change it, and `state_ref` below takes the
                        // delivered one either way: what the sheets show has
                        // to be the same choice, or the Formatting button
                        // would say one thing and the next layout change store
                        // another. The same array when nothing changed, asked
                        // of every sheet by index: a toggle on a later sheet
                        // leaves holes before it, which `every` would skip.
                        const next_show_formatting = authoritative_state.showFormatting ?? [];
                        set_show_formatting_by_sheet((shown) => {
                            if (shown.length !== next_show_formatting.length) {
                                return next_show_formatting;
                            }
                            for (let index = 0; index < shown.length; index += 1) {
                                if (shown[index] !== next_show_formatting[index]) {
                                    return next_show_formatting;
                                }
                            }
                            return shown;
                        });
                        set_transforms(next_transforms);
                        set_column_visibility(next_column_visibility);
                        note_grid_replaced(next_active_sheet_index);
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
                    const next_edit_session = snapshot.capabilities.csvEditSessionId;
                    if (
                        session_held_before_snapshot
                        && editing_session_held_ref.current
                        && next_edit_session !== undefined
                        && next_edit_session !== edit_session_before_snapshot
                    ) {
                        advance_edit_activation();
                    }
                    set_csv_edit_session_id(next_edit_session);
                    set_csv_editing_supported(
                        snapshot.capabilities.csvEditingSupported,
                    );
                    set_edit_syntax(snapshot.capabilities.editSyntax ?? 'plain');
                    const ceiling = snapshot.capabilities.appendRowCeiling;
                    set_append_row_ceiling(
                        ceiling === undefined
                            ? MAX_SHEET_ROWS
                            : ceiling ?? UNBOUNDED_SHEET_ROWS,
                    );
                    set_structural_editing(snapshot.capabilities.structuralEditing);

                    // View requests this snapshot overtook, judged by the state
                    // it has just installed.
                    settle_overtaken_view_requests();
                    refresh_view_action_ref.current(snapshot);
                    // A fit the host refused may be tried again now.
                    owed_fit_held_ref.current = new Set();
                    // Counted here and nowhere else: what a held press and a
                    // retry read is "a snapshot was applied", and the render
                    // this state change causes is what drains them.
                    applied_snapshot_seq_ref.current += 1;
                    set_applied_snapshot_count((count) => count + 1);
                    // Acknowledge the exact delivered identity before an optional
                    // corrective CAS write.
                    snapshot_applied_seq_ref.current += 1;
                    host_bridge.postMessage({
                        type: 'snapshotApplied',
                        identity: snapshot.identity,
                        disposition,
                    });
                    if (correction_required) persist_immediate();
                } else {
                    snapshot_applied_seq_ref.current += 1;
                    // Not applied, but acknowledged: a cell or structural
                    // replay's retry waits for exactly this.
                    wake_history_press();
                    host_bridge.postMessage({
                        type: 'snapshotApplied',
                        identity: snapshot.identity,
                        disposition,
                    });
                }
            }

            if (msg.type === 'structuralSaveUnresolved') {
                set_structural_save_notice(msg.notice);
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
                notify_transform_settled();
                // A refused view request records nothing and moves nothing: a
                // gesture did not happen, and a replay's entry stays where it
                // was, to be tried again.
                const refused_view = pending_view_transforms_ref.current[msg.sheetIndex];
                const refused_replay = refused_view?.requestId === msg.requestId
                    ? refused_view.replay
                    : undefined;
                pending_view_transforms_ref.current[msg.sheetIndex] = undefined;
                sync_view_request_pending();
                // Not for a replay: this latch stops the sheet's saved view from
                // being re-requested, and a refused undo says nothing about the
                // saved view.
                if (msg.terminal && refused_replay === undefined) {
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
                if (refusal_origin === 'grid' || refusal_origin === 'history') {
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
                if (refused_replay !== undefined) {
                    // The press waiting behind it was for the stack as this
                    // replay would have left it.
                    refuse_history_press(view_replay_refusal_warning(
                        refused_replay.direction,
                        refused_replay.entry.action.label,
                        msg.reason,
                    ));
                    // A refused replay renders nothing; a queued header change waits on it.
                    wake_header_drain();
                } else if (!(refusal_origin === 'restore' && !msg.terminal)) {
                    host_bridge.postMessage({
                        type: 'showWarning',
                        message: `Could not update the table view: ${msg.reason}`,
                    });
                }
                const refused_action = view_action_ref.current;
                if (
                    refused_action !== undefined
                    && view_action_owns(refused_action.action, msg.requestId)
                ) {
                    // The action ends when the host settles it; what a press behind
                    // it does is decided then, by whether anything was recorded.
                    view_action_ref.current = { ...refused_action, refused: true };
                } else if (refused_replay === undefined && refusal_origin !== 'restore') {
                    // The person's own gesture was refused, so nothing was recorded: a press
                    // held behind it was for its step, and would otherwise undo the one under it
                    // (as with Cancel).
                    drop_press_behind_unrecorded_gesture();
                }
                return;
            }

            if (msg.type === 'transformSettled') {
                perf_mark('tv:view-request-settled', { requestId: msg.requestId });
                const settled_action = view_action_ref.current;
                if (
                    settled_action === undefined
                    || settled_action.action.sheetIndex !== msg.sheetIndex
                    || !view_action_owns(settled_action.action, msg.requestId)
                ) return;
                // What the host has installed now, which a reconciliation after the
                // answer can have changed: taken whole, as an install is, before the
                // action decides on it (I3). It does not wait for a snapshot.
                if (
                    msg.projection !== undefined
                    && msg.projection.view.basis.generation > generation_ref.current
                ) {
                    handler({
                        data: {
                            type: 'transformInstalled',
                            sheetIndex: msg.sheetIndex,
                            requestId: msg.requestId,
                            intent: 'user',
                            ...msg.projection,
                        } satisfies HostMessage,
                    } as MessageEvent);
                }
                settle_view_action_ref.current(msg);
                return;
            }

            if (msg.type === 'transformInstalled') {
                const answers_newest = pending_transform_request_ids_ref.current[msg.sheetIndex]
                    === msg.requestId;
                // An answer for a request of the view action that a newer one
                // replaced: the host did install it, so the window shows it, and
                // the action records it if nothing later does (I3).
                const pending_action = view_action_ref.current;
                const action_owned = pending_action !== undefined
                    && pending_action.action.sheetIndex === msg.sheetIndex
                    && view_action_owns(pending_action.action, msg.requestId);
                if (!answers_newest && !action_owned) return;
                if (action_owned) {
                    view_action_ref.current = {
                        ...pending_action,
                        action: install_in_view_action(pending_action.action, msg.requestId, msg.rules),
                    };
                }
                if (!answers_newest && msg.view.basis.generation <= generation_ref.current) return;
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
                // A view request of this window (a gesture that records, or a
                // replay) folded the open editor before it was posted, and cells
                // have offered no editor since, so there is nothing to fold here
                // and the fold is not attempted: it can answer false with
                // nothing open (an exiting session's fence), and returning on
                // that would leave this window on a generation the host has
                // left. A restore and a cancel keep the fold-or-return.
                const pending_view = pending_view_transforms_ref.current[msg.sheetIndex];
                const view_request = answers_newest && pending_view?.requestId === msg.requestId
                    ? pending_view
                    : undefined;
                if (view_request !== undefined) {
                    pending_view_transforms_ref.current[msg.sheetIndex] = undefined;
                    sync_view_request_pending();
                    if (view_request.replay !== undefined) {
                        // The replay landed: history moves on the host's answer.
                        land_view_replay(
                            view_request.replay,
                            view_request.worksheet,
                            false,
                            view_request.target !== undefined && !transform_slices_equal(
                                view_request.replay.delta,
                                view_request.target,
                                msg.rules,
                            ),
                        );
                        wake_header_drain();
                    }
                }
                if (view.basis.generation !== generation_ref.current) {
                    // An action's request folded the open editor when it was made,
                    // and cells have offered none since, like any view request's.
                    if (
                        view_request === undefined
                        && !action_owned
                        && editing_ref.current?.commit_live_edit() === false
                    ) return;
                    set_grid_mount_epoch((epoch) => epoch + 1);
                }
                // Read before the newest request's bookkeeping is cleared; an older
                // request of the action has none of its own left.
                const origin = answers_newest
                    ? pending_transform_origins_ref.current[msg.sheetIndex]
                    : undefined;
                if (answers_newest) {
                    pending_transform_request_ids_ref.current[msg.sheetIndex] = undefined;
                    pending_transform_states_ref.current[msg.sheetIndex] = undefined;
                    pending_transform_origins_ref.current[msg.sheetIndex] = undefined;
                    notify_transform_settled();
                    if (origin === 'grid' || origin === 'history') {
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
                }
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
                // The gesture landed: its step is what it changed, from the
                // rules it was composed against to the rules installed. Hide
                // rows learns its source rows here. A view action's step waits
                // for the host to settle everything the action sent (I2, I3).
                if (view_request !== undefined && view_request.replay === undefined && !action_owned) {
                    record_view_step(transform_view_step(
                        view_request.worksheet,
                        view_request.schema,
                        view_request.baseline,
                        msg.rules,
                    ));
                }
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
                    pending_auto_fit_snapshot_ref.current[msg.sheetIndex] = undefined;
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
        set_sheet_views,
        update_pending_auto_fit_sheets,
        wake_header_drain,
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
            // The token may have been armed while no replacement grid existed.
            // A newer connected focus target means the user moved on during that
            // window; do not steal focus from it when the retry finally runs.
            if (
                has_surviving_focus_target()
                && handle?.has_focus() !== true
            ) {
                set_grid_focus_restore((current) => (
                    current === grid_focus_restore ? null : current
                ));
                return;
            }
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
                // Reached with the document focused and no control holding
                // focus: both were asked above, on this same attempt.
                if (grid_focus_restore.or_toolbar) toolbar_focus_ref.current?.focus();
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
            if (!has_surviving_focus_target() && document.hasFocus()) {
                toolbar_focus_ref.current?.focus();
            }
            set_toolbar_focus_restore((current) => (
                current === toolbar_focus_restore ? null : current
            ));
        }, 0);
        return () => window.clearTimeout(timer);
    }, [active_sheet_index, toolbar_focus_restore]);

    useEffect(() => {
        host_bridge.postMessage({
            type: 'ready',
            structuralLayout: WEBVIEW_STRUCTURAL_LAYOUT_VERSION,
        });
        return () => {
            release_edit_session();
        };
    }, []);

    // Recompute persisted transforms against each freshly loaded source. The
    // host intentionally drops permutations on reload because matching schema
    // does not imply matching values.
    //
    // Not gated on editing_session_held: the host admits a transform from the panel holding
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
    // Bumped when a session request is answered and when a replay attempt
    // ends, the two things the restore effect waits out; neither need render
    // by itself.
    const [restore_wake, set_restore_wake] = useState(0);
    // The restore effect stepped aside for a replay: the attempt's end wakes it.
    const restore_waits_for_replay_ref = useRef(false);
    useEffect(() => {
        set_restore_blocker_epoch((n) => n + 1);
    }, [csv_editable, save_in_flight]);
    useEffect(() => {
        if (!meta || preview_mode || pending_excel_header !== null) return;
        if (save_in_flight) return;
        // Not while this window's request for an editing session is out: the
        // host may still be settling the session a Save let go when the
        // restore reaches it, and a transform it starts meanwhile refuses that
        // session ("Wait for sorting and filtering to finish before editing."),
        // and with it the edit or the Undo that asked. The restore goes once
        // the request is answered. (The ref is the request as posted, before
        // the render that shows it.) Nor while a replay is out: it would
        // install under the replay's lease. `restore_wake` runs this again
        // when either ends.
        if (edit_session_pending || pending_edit_request_ref.current !== null) return;
        if (replay_coordinator_ref.current?.is_busy() || pending_row_replay_busy_ref.current) {
            restore_waits_for_replay_ref.current = true;
            return;
        }
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
        const installed = sheet_views[active_sheet_index];
        const state = reconciliation_intent(
            sanitize_transform_state(
                state_ref.current.transforms?.[active_sheet_index],
                sheet.columnCount,
                transform_schema_for_sheet(sheet),
                sheet.sourceRowCount,
            ),
            installed,
            transform_schema_for_sheet(sheet),
        );
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
        // Deliberately not gated on the session. `admit_transform_for_phase` refuses a
        // sibling's transform while we own the session, so the durable rules cannot
        // go inactive from a sibling mid-session; a gate here would instead create a
        // state that never reconciles, since ending the session moves no dep of this
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
        edit_session_pending,
        restore_wake,
        restore_blocker_epoch,
    ]);

    /**
     * Whether a cell gesture may enter the history right now.
     *
     * Two reservations, one predicate, because both are about the same thing —
     * an edit must not be RECORDED while another gesture is mid-flight for the
     * same history:
     *
     *   - A replay in flight owns the history's next move.
     *   - A highlight round trip is recorded only when the host's deltas come
     *     back, so an edit committed inside that window would enter the history
     *     BEFORE the highlight the user made first, and undo would revert the
     *     highlight instead of the typing.
     *
     * Here rather than in the grid because this is where every recorded gesture
     * converges: `run_edit_gesture` gates the overlay editor, paste, Glide's
     * fill hotkeys AND the hyperlink dialog, which reaches the store through
     * `commit_hyperlinks` and no grid-side editability flag.
     * GridShell's `highlight_in_flight` prop is the affordance, not the barrier —
     * it stops a cell opening at all, so nothing the user types is silently
     * swallowed.
     *
     * Stable across renders because a gesture starts and ends inside event
     * handlers: making this depend on rendered state would rebuild the editing
     * callbacks mid-gesture, and a wide paste is assembled across many of them.
     * Both reservations therefore live in refs.
     */
    const base_gestures_admitted = useCallback(
        // `ignore_reopen`: for releasing an idle session, which sends nothing
        // of the stores and is the one thing a window that must be reopened
        // still does.
        (options?: GestureAdmissionOptions) => !header_fence_ref.current
            && (options?.ignore_reopen === true || !reopen_required_ref.current)
            && (
                (options?.replay_waiting_may_pass === true && replay_waiting_for_transforms_ref.current > 0)
                || (
                    !(replay_coordinator_ref.current?.is_busy() ?? false)
                    && !pending_row_replay_busy_ref.current
                )
            )
            && pending_highlight_request_ref.current === null
            && pending_row_resize_requests_ref.current.size === 0
            && pending_append_requests_ref.current.size === 0
            // Backpressure against a host that has stopped acknowledging:
            // each unacknowledged structural publication is kept until it is
            // acknowledged, so a refresh echoing it is recognized.
            && !(csv_edit_session_id_ref.current !== undefined
                && pending_changes_durability.structural_backlog_full(csv_edit_session_id_ref.current)),
        [],
    );
    /**
     * Whether history's next move is free: the terms above, and no view step's
     * replay or column write in flight. A view replay moves its entry only when
     * the host answers, and a column write records or moves only on its answer,
     * so until then the next undo, redo, or view request has to wait.
     *
     * A person's own sort, filter, or hide in flight does not count here: a
     * second one on the same sheet may still replace it, as it always could.
     *
     * And no press of Undo or Redo waiting (`press_admits`), unless the work
     * that asks was made before that press and says so with its ticket: a
     * gesture made after a press must not be recorded under it, and the work
     * the press waits for must still finish.
     */
    const history_free = useCallback(
        (options?: GestureAdmissionOptions) => base_gestures_admitted(options)
            && press_admits()
            && pending_column_write_ref.current === null
            && pending_width_write_ref.current === null
            && !pending_view_transforms_ref.current.some((pending) => pending?.replay !== undefined),
        [base_gestures_admitted, press_admits],
    );
    /**
     * Whether an edit may be recorded now: `history_free`, and no sort, filter,
     * or hide of this window still in flight. That one records its step only
     * when it installs, so an edit recorded meanwhile would enter history ahead
     * of the gesture the person made first.
     */
    const edit_gestures_admitted = useCallback(
        (options?: GestureAdmissionOptions) => history_free(options)
            && view_action_ref.current === undefined
            && !pending_view_transforms_ref.current.some((pending) => pending !== undefined),
        [history_free],
    );

    // Every part of the grid's key: a change to any one mounts a new grid.
    const grid_sheet_identity = meta?.sheets[active_sheet_index]?.worksheetId
        ?? meta?.sheets[active_sheet_index]?.name;
    useLayoutEffect(() => {
        grid_instance_ref.current += 1;
    }, [active_sheet_index, grid_sheet_identity, load_epoch, grid_mount_epoch]);
    // Counts the changes of active sheet, so a gesture can tell it was left
    // even if the person came back to its sheet.
    const sheet_visit_ref = useRef(0);
    useLayoutEffect(() => {
        sheet_visit_ref.current += 1;
    }, [active_sheet_index]);
    /**
     * Counted at once where the grid is replaced, not only when React has
     * committed it (the layout effects above): a gesture's wait resumes in a
     * microtask, before that commit. An extra count only ends a waiting
     * gesture, silently.
     */
    const note_grid_replaced = useCallback((next_sheet_index?: number) => {
        if (next_sheet_index !== undefined) {
            if (next_sheet_index === active_sheet_index_for_focus_ref.current) return;
            sheet_visit_ref.current += 1;
        }
        grid_instance_ref.current += 1;
    }, []);

    const handle_sheet_select = useCallback(
        (sheet_index: number) => {
            // The grid is keyed by the active sheet, so this unmounts the one
            // holding any open overlay editor — and Glide portals that editor
            // outside the tree, so its cleanup releases the captured row without
            // committing the text. Fold it first, as the transform and refresh
            // remounts do; the store lives above the grid and keeps it.
            if (
                editing_session_held_ref.current
                && editing_ref.current?.commit_live_edit() === false
            ) return false;
            set_filter_editor(null);
            set_grid_focus_restore(null);
            set_toolbar_focus_restore(null);
            cancel_external_change_navigation();
            set_open_external_change_occurrence(null);
            set_external_change_navigation_status('');
            note_grid_replaced(sheet_index);
            set_active_sheet_index(sheet_index);
            state_ref.current = {
                ...state_ref.current,
                activeSheetIndex: sheet_index,
            };
            persist_immediate();
            return true;
        },
        [cancel_external_change_navigation, persist_immediate]
    );

    handle_sheet_select_ref.current = handle_sheet_select;

    useLayoutEffect(() => {
        const pending = rejected_sheet_grid_focus_ref.current;
        if (!pending || pending.sheet_index !== active_sheet_index) return;
        rejected_sheet_grid_focus_ref.current = null;
        set_grid_focus_restore(pending);
    }, [active_sheet_index, set_grid_focus_restore]);

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

    /**
     * Where the last undo or redo landed, held until a GridShell consumes it.
     *
     * Held rather than applied directly, because a workbook-wide history can
     * replay onto a sheet the user is not looking at: the switch below remounts
     * the grid, and the request has to outlive that to reach the grid that can
     * honour it.
     */
    const [history_focus, set_history_focus] = useState<PendingHistoryFocus | null>(null);
    /** The last projection posted, so an unchanged one is not posted again. */
    const history_menu_state_ref = useRef<HistoryMenuProjection | undefined>(undefined);
    const history_focus_sequence_ref = useRef(0);
    /**
     * The live request, mirrored so a callback can read it without depending on
     * it. `handle_history_focus_applied` is handed to the grid and must not be
     * rebuilt every time a replay installs a new request.
     */
    const history_focus_ref = useRef<PendingHistoryFocus | null>(null);

    /** Structural-only replay has no cell focus request to survive a remount. */
    const deferred_history_grid_focus_ref = useRef<number | null>(null);

    // GridShell installs its imperative handle in a child layout effect. The
    // parent layout effect therefore runs after a history-driven sheet remount
    // can accept this one-shot bare-grid focus intent.
    useLayoutEffect(() => {
        if (deferred_history_grid_focus_ref.current !== active_sheet_index) return;
        deferred_history_grid_focus_ref.current = null;
        grid_focus_ref.current?.focus();
    }, [active_sheet_index]);

    const handle_history_focus_applied = useCallback((
        sequence: number,
        outcome: HistoryFocusOutcome,
    ) => {
        // Only the request that was answered: a newer replay may already have
        // replaced it, and clearing unconditionally would drop that one unapplied.
        // Matched against the ref rather than inside the updater, because the
        // answer decides whether to warn as well as what to clear, and a state
        // updater that also posted a message would post it twice under
        // StrictMode's double invocation.
        const answered = history_focus_ref.current;
        if (answered === null || answered.sequence !== sequence) return;
        history_focus_ref.current = null;
        set_history_focus((current) => (current?.sequence === sequence ? null : current));
        if (outcome.kind === 'rows-hidden' || outcome.kind === 'columns-hidden') {
            // Said out loud, because the replay DID land: the durable state
            // changed and the cursor did not move, and silence would read as
            // nothing having happened. The filters are deliberately left alone:
            // undoing an edit keeps the view as it is. A filter is its own step
            // in history, and clearing one here to expose the row would make
            // this undo change view state the person never asked about.
            say_history(
                `The change was ${replayed_verb(answered.direction)}, but the affected cells are hidden by the current view.`,
            );
        }
    }, [say_history]);

    /**
     * The committed answer as this window's sheets read now.
     *
     * The host names sheets by the index they had when the preparation was
     * sent, and a delivery that reorders or renames them may have reached this
     * window first: after a commit whose view moved (`viewMoved`), or before
     * an answer re-sent after a lost one. Each index is mapped to where the
     * same worksheet is now: by its id when both have one, else by its name.
     * Undefined when one has gone. Cell keys are source coordinates, the keys
     * durable state holds them by, and are kept. A display focus whose sheet
     * moved is dropped: its rows are the old index's, so the cursor stays
     * with the grid rather than following them.
     */
    const committed_for_view = useCallback((
        committed: HistoryReplayCommitted,
    ): HistoryReplayCommitted | undefined => {
        const sent = replay_commit_sheets_ref.current;
        const sheets = meta_ref.current?.sheets;
        if (
            sent === null
            || sheets === undefined
            || sent.replayId !== committed.replayId
        ) return committed.viewMoved === true ? undefined : committed;
        const mapped = new Map<number, number>();
        const map = (index: number): number | undefined => {
            if (mapped.has(index)) return mapped.get(index);
            const then = sent.sheets[index];
            if (then === undefined) return undefined;
            const same = (sheet: { readonly name: string; readonly worksheetId?: string }) => (
                then.worksheetId !== undefined && sheet.worksheetId !== undefined
                    ? sheet.worksheetId === then.worksheetId
                    : sheet.name === then.name
            );
            // Where it was, when it is still there: a search could find
            // another sheet of the same name first.
            const now = sheets[index] !== undefined && same(sheets[index])
                ? index
                : sheets.findIndex(same);
            if (now < 0) return undefined;
            mapped.set(index, now);
            return now;
        };
        const focus_sheet = map(committed.focusSheetIndex);
        if (focus_sheet === undefined) return undefined;
        const cells: HistoryReplayCommitted['cells'][number][] = [];
        for (const write of committed.cells) {
            const index = map(write.resolvedSheetIndex);
            if (index === undefined) return undefined;
            cells.push({ ...write, resolvedSheetIndex: index });
        }
        const structures: NonNullable<HistoryReplayCommitted['structures']>[number][] = [];
        for (const write of committed.structures ?? []) {
            const index = map(write.resolvedSheetIndex);
            if (index === undefined) return undefined;
            structures.push({ ...write, resolvedSheetIndex: index });
        }
        return {
            ...committed,
            cells,
            ...(committed.structures === undefined ? {} : { structures }),
            focusSheetIndex: focus_sheet,
            // Display rows belong to the sheet at the index the host saw.
            displayFocus: focus_sheet === committed.focusSheetIndex ? committed.displayFocus : null,
        };
    }, []);

    /**
     * Land an accepted replay, then send the cursor after it.
     *
     * The focus is installed only if the local transaction COMMITTED. A focus
     * request for writes that never landed would move the cursor to a region and
     * flash it to advertise a change the renderer does not hold.
     */
    const handle_committed_history_replay = useCallback((accepted: AcceptedReplay) => {
        // The accepted host terminal owns the complete cursor destination even
        // when this renderer can no longer apply its writes. Leaving an older
        // request alive would move the cursor after the
        // newer replay has already committed and this view has declared itself
        // divergent.
        history_focus_ref.current = null;
        set_history_focus(null);
        deferred_history_grid_focus_ref.current = null;
        const committed = committed_for_view(accepted.committed);
        const landing: ReplayLanding = committed === undefined
            ? 'diverged'
            : apply_committed_replay(committed, accepted.entry, accepted.direction);
        if (
            accepted.committed.viewMoved === true
            && accepted.committed.stateRevision !== undefined
            && last_applied_snapshot_ref.current !== null
        ) {
            replay_state_floor_ref.current = {
                fileId: last_applied_snapshot_ref.current.authority.fileId,
                stateRevision: accepted.committed.stateRevision,
            };
        }
        if (landing === 'unstaged') {
            // The write is in the file and the view moved under it, and no
            // session holds the stores now: the next one is hydrated from
            // durable state, which holds the write. History takes the step
            // alone and nothing is said. (Anything else this window cannot
            // follow, a worksheet gone included, is said below.)
            const move = history_store_ref.current!.stage_move(accepted.direction, accepted.entry);
            if (commit_staged_transaction([move])) {
                const structural = pending_row_replay_plan_ref.current;
                if (structural?.entryId === accepted.entry.id) {
                    structural.settleRestorations.forEach((settle) => settle(true));
                    pending_row_replay_plan_ref.current = null;
                }
                return;
            }
        }
        if (committed === undefined || landing !== 'applied') {
            // The host committed and the renderer could not follow, which no
            // further undo can describe: the two are now telling different stories
            // about the document.
            // A press waiting behind it was for a stack this view no longer
            // agrees with the file about: dropped with the message.
            raise_reopen_fence();
            refuse_history_press(
                `The change was ${replayed_verb(accepted.direction)} in the file, but this view could not be updated. Reopen the file to resynchronize.`,
            );
            return;
        }
        const display_focus = committed.displayFocus;
        const structural_only = accepted.entry.action.changes.length > 0
            && accepted.entry.action.changes.every((change) => (
                is_structural_history_change(change)
            ));
        // A change to a Header Row has no display row: the row is the column
        // headers. Where one of them is on screen the change is in view, and
        // the grid keeps the keyboard as it does after a structural replay.
        const focus_sheet = meta_ref.current?.sheets[committed.focusSheetIndex];
        const landed_in_shown_header = display_focus === null
            && focus_sheet !== undefined
            && replay_focus_is_shown_header(
                committed.focus,
                focus_sheet,
                hidden_source_columns(
                    state_ref.current.columnVisibility?.[committed.focusSheetIndex],
                    focus_sheet.columnCount,
                ),
            );
        if (display_focus !== null) {
            const request = history_focus_request(
                history_focus_sequence_ref.current += 1,
                accepted.direction,
                committed.focusSheetIndex,
                display_focus,
                committed.focus.sourceColumnStart,
                committed.focus.sourceColumnEnd,
            );
            history_focus_ref.current = request;
            set_history_focus(request);
        } else if (
            !structural_only
            && !landed_in_shown_header
            && committed.viewMoved !== true
            && committed.focusSheetIndex === accepted.committed.focusSheetIndex
        ) {
            // (After a view that moved, or onto a sheet that moved, the host's
            // display rows may be for a view this window no longer shows:
            // nothing true to say.)
            // Every touched row is filtered out of the view. The replay succeeded;
            // there is simply nowhere truthful for the cursor to go.
            say_history(
                `The change was ${replayed_verb(accepted.direction)}, but the affected cells are hidden by the current view.`,
            );
        } else if (committed.focusSheetIndex === active_sheet_index) {
            // Structural-only replay has no source-keyed cells from which the
            // host can derive a display row, and a replay that landed in the
            // column headers has no body row. The store transaction has already
            // clamped any removed selection or installed the restored pending
            // row, so retain keyboard ownership without pretending the row was
            // filtered out.
            grid_focus_ref.current?.focus();
        } else {
            deferred_history_grid_focus_ref.current = committed.focusSheetIndex;
        }
        // The cursor follows what changed, which for a workbook-wide history can be
        // a sheet the user is not looking at.
        //
        // Order relative to the focus install above does not matter — both are
        // state updates React batches into the one render, so no grid ever observes
        // a switched sheet without the request. What DOES matter is that the
        // request is state and not a call: the grid for that sheet has yet to
        // mount, and it finds the request waiting when it does.
        if (committed.focusSheetIndex !== active_sheet_index) {
            handle_sheet_select(committed.focusSheetIndex);
        }
    }, [
        active_sheet_index,
        apply_committed_replay,
        committed_for_view,
        handle_sheet_select,
        refuse_history_press,
        say_history,
    ]);

    /**
     * Keep the desktop's native Edit menu in step with the history.
     *
     * Posted rather than derived, because the menu is in another process and
     * cannot read the stack. Diffed against the last post, because rebuilding an
     * application menu is not free and the three inputs move for reasons that
     * usually change nothing: a keystroke that dirties a cell moves neither
     * label, and a focus change between two grid elements is not a change of
     * text-editing state.
     *
     * Harmless in the VS Code webview, which has no native menu — the host
     * ignores a message type it does not handle — and cheap enough not to be
     * worth a platform test that the renderer cannot make reliably anyway.
     */
    const publish_history_menu_state = useCallback(() => {
        const store = history_store_ref.current;
        if (store === null) return;
        const pending = view_action_ref.current;
        const projection = history_menu_projection(
            store.snapshot(),
            edit_command_target(document.activeElement) === 'text',
            pending === undefined || pending.action.cancelled
                ? undefined
                : transform_view_step(
                    pending.worksheet,
                    pending.schema,
                    pending.action.baseline,
                    pending.action.requested,
                )?.label,
        );
        // The helper already answers false for a ref that has never been posted,
        // which is what makes the first publish happen.
        if (history_menu_projections_equal(history_menu_state_ref.current, projection)) return;
        history_menu_state_ref.current = projection;
        host_bridge.postMessage({ type: 'historyMenuStateChanged', state: projection });
    }, []);
    publish_history_menu_ref.current = publish_history_menu_state;

    const publish_retained_saved_append_authorities = useCallback(() => {
        const store = history_store_ref.current;
        if (store === null) return;
        const grouped = new Map<string, {
            worksheet: WorksheetTarget;
            ids: Set<string>;
            pendingIds: Set<string>;
            columnIds: Set<string>;
        }>(retained_saved_append_authorities(store.snapshot()).map(
            (entry) => [worksheet_target_key(entry), {
                worksheet: entry,
                ids: new Set(entry.appendHistoryIds),
                pendingIds: new Set(),
                columnIds: new Set(),
            }],
        ));
        for (const entry of retained_pending_row_authorities(store.snapshot())) {
            const key = worksheet_target_key(entry);
            const group = grouped.get(key) ?? {
                worksheet: entry,
                ids: new Set<string>(),
                pendingIds: new Set<string>(),
                columnIds: new Set<string>(),
            };
            for (const id of entry.pendingRowIds) group.pendingIds.add(id);
            for (const id of entry.pendingColumnIds) group.columnIds.add(id);
            grouped.set(key, group);
        }
        const sheets = meta_ref.current?.sheets ?? [];
        for (const [sheetIndex, pending] of edit_session_registry_ref.current!.pending_entries()) {
            const sheet = sheets[sheetIndex];
            if (sheet === undefined) continue;
            const worksheet = {
                sheetIndex,
                sheetName: sheet.name,
                ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
            };
            const key = worksheet_target_key(worksheet);
            const group = grouped.get(key) ?? {
                worksheet,
                ids: new Set<string>(),
                pendingIds: new Set<string>(),
                columnIds: new Set<string>(),
            };
            for (const removal of pending.snapshot().tailRemovals) {
                group.ids.add(removal.appendHistoryId);
            }
            // A discarded Pending Inserted Row is no longer published as a row,
            // but its tombstone still names its admitted ID.
            for (const row of pending.snapshot().rowLayout?.discardedPendingRows ?? []) {
                group.pendingIds.add(row.id);
            }
            for (const column of pending.snapshot().columnLayout?.discardedPendingColumns ?? []) {
                group.columnIds.add(column.id);
            }
            grouped.set(key, group);
        }
        host_bridge.postMessage({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [...grouped.values()].map(({ worksheet, ids, pendingIds, columnIds }) => ({
                ...worksheet,
                appendHistoryIds: [...ids],
                pendingRowIds: [...pendingIds],
                ...(columnIds.size === 0 ? {} : { pendingColumnIds: [...columnIds] }),
            })),
        });
    }, []);

    /**
     * Both things the projection is built from, watched where each moves.
     *
     * The stack has a subscription — and a landed replay moves it, so that is also
     * what keeps the labels fresh across an undo. Text-editing focus has
     * capture-phase focus events, because focusin/focusout do not bubble from every
     * element the CSV editor uses.
     *
     * The initial publish is the effect body, not a separate call: a window whose
     * history is empty still has to say so, or the menu would keep the enabled
     * items it was built with before any viewer reported.
     */
    useEffect(() => {
        publish_history_menu_state();
        publish_retained_saved_append_authorities();
        const unsubscribe = history_store_ref.current!.subscribe(() => {
            perf_mark('tv:history-changed');
            publish_history_menu_state();
            publish_retained_saved_append_authorities();
            set_redo_available(
                peek_history(history_store_ref.current!.snapshot(), 'redo').kind === 'available',
            );
        });
        const unsubscribe_edit_session = edit_session_registry_ref.current!.subscribe(
            publish_retained_saved_append_authorities,
        );
        const on_focus_change = () => publish_history_menu_state();
        window.addEventListener('focusin', on_focus_change, true);
        window.addEventListener('focusout', on_focus_change, true);
        return () => {
            unsubscribe();
            unsubscribe_edit_session();
            window.removeEventListener('focusin', on_focus_change, true);
            window.removeEventListener('focusout', on_focus_change, true);
        };
    }, [publish_history_menu_state, publish_retained_saved_append_authorities]);

    const run_history_command_ref = useRef<(press: HistoryPress) => Promise<void>>(async () => {});
    /** `post_column_widths`, which is declared further down. */
    const post_column_widths_ref = useRef<((
        sheets: readonly WidthWriteSheet[],
        options?: {
            readonly replay?: ViewReplay;
            readonly owed?: boolean;
            readonly auto_fit_extras_before?: AutoFitExtras;
        },
    ) => boolean) | null>(null);
    /** `enqueue_excel_header_change`, which is declared further down. */
    const enqueue_excel_header_change_ref = useRef<((request: HeaderQueueRequest) => boolean) | null>(null);
    /**
     * What stops a Header Row change on these worksheets before it is asked
     * for: the refusals that depend only on a worksheet's unsaved changes and
     * need no round trip (a layout conflict notice, a live new column). The
     * host runs the full rebase in the write.
     */
    const header_change_refusal = useCallback((sheet_indices: readonly number[]): string | undefined => {
        const sheets = meta_ref.current?.sheets ?? [];
        for (const sheet_index of sheet_indices) {
            const sheet = sheets[sheet_index];
            if (sheet === undefined) continue;
            const refusal = header_rebase_slot_refusal(
                {
                    cells: {},
                    ...edit_session_registry_ref.current!.pending_rows_for_sheet(sheet_index).snapshot(),
                },
                header_body_start(sheet.excelFirstRowHeader),
            );
            if (refusal !== undefined) return refusal;
        }
        return undefined;
    }, []);
    /** `post_column_visibility`, which is declared further down. */
    const post_column_visibility_ref = useRef<((
        sheet_index: number,
        before: SheetColumnVisibilityState | undefined,
        after: SheetColumnVisibilityState | undefined,
        replay?: ViewReplay,
    ) => boolean) | null>(null);

    /**
     * Undo or redo a view step: a sort, a filter, hidden rows, hidden columns,
     * column widths, row heights.
     *
     * Replayed through the request its gesture used (`setTransform`,
     * `setColumnVisibility`, `setColumnWidths`), except row heights: the
     * gesture names display rows and the step holds source rows, so it is
     * replayed through `setSourceRowHeights`. No editing session, and not the
     * cell replay protocol, which exists to compare-and-swap document content.
     * The host keeps every rule it has and persists what it installs, so the
     * saved view follows undo and redo. History moves on the host's answer.
     *
     * Replay writes from the live state and never compares (see
     * `view-history-model.ts`). The parts of a step that cannot apply now, for
     * a reason this window can see, are skipped with a message and the entry
     * moves on all the same: a view step never stands in the way of an older
     * step. Everything that says "did not run" leaves the entry where it was.
     */
    const replay_view_step = useCallback((entry: HistoryEntry, press: HistoryPress) => {
        const direction = press.direction;
        // Said at once, for what does not clear by itself. A press waiting
        // behind this one is dropped with it (`refuse_history_press`).
        const say_wait = (wait: ViewReplayWait) => {
            refuse_history_press(view_replay_wait_warning(wait, direction));
        };
        const say_unavailable = () => {
            refuse_history_press(history_refusal_warning('unavailable', direction, undefined));
        };
        // What every replay of this press carries to its settle site.
        const replay_of = (skipped: readonly ViewSkipReason[]): ViewReplay => ({
            entry,
            direction,
            skipped,
            press,
            posted_after: applied_snapshot_seq_ref.current,
        });
        const sheets = meta_ref.current?.sheets;
        const width_changes = width_step_changes(entry.action);
        if (width_changes !== undefined && sheets !== undefined) {
            // (A save, a claim, or a header request in flight held the press
            // before it got here: `history_press_gate`.)
            // Member by member, from the step alone: each column gets the
            // step's other side, and columns it never touched keep what they
            // have. Whether anything is left to change is the host's to say,
            // since this window's widths can be stale. A worksheet or a
            // column that is gone is left out, with a message.
            const skipped = new Set<ViewSkipReason>();
            const writes: WidthWriteSheet[] = [];
            const present: number[] = [];
            let first_worksheet: WorksheetTarget | undefined;
            let undoes_a_fit = false;
            for (const { delta: width_delta } of width_changes) {
                const index = worksheet_target_index(sheets, width_delta.worksheet);
                const sheet = index === undefined ? undefined : sheets[index];
                if (index === undefined || sheet === undefined) {
                    skipped.add('sheets-gone');
                    continue;
                }
                present.push(index);
                first_worksheet ??= {
                    sheetIndex: index,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                };
                const target = column_widths_replay_target(width_delta, direction, sheet.columnCount);
                for (const reason of target.skipped) skipped.add(reason);
                if (target.widths.length === 0) continue;
                if (width_delta.autoFit === 'on' && direction === 'undo') undoes_a_fit = true;
                // Walking history leaves the toolbar as the gesture left it:
                // Auto-fit on again restores to the widths the sheet has just
                // before this replay writes, which in order are the ones the
                // fit replaced.
                const current = state_ref.current.columnWidths?.[index];
                writes.push({
                    sheet_index: index,
                    widths: target.widths,
                    auto_fit: auto_fit_after_width_replay(width_delta, direction) === 'on'
                        ? { active: true, snapshot: current ? { ...current } : undefined }
                        : { active: false },
                });
            }
            if (first_worksheet === undefined) {
                say_unavailable();
                return;
            }
            const replay = replay_of((['sheets-gone', 'columns-gone'] as const)
                .filter((reason) => skipped.has(reason)));
            // Undo shows a worksheet its step belongs to.
            if (!present.includes(active_sheet_index) && !handle_sheet_select(present[0]!)) {
                say_wait('applying');
                return;
            }
            if (writes.length === 0) {
                // Every member was left out.
                land_view_replay(replay, first_worksheet, true);
                wake_header_drain();
                return;
            }
            // Taking a fit back: a fit still owed to another worksheet would
            // be the opposite of what the person asked. A replay the host
            // refuses did not happen, so what is dropped here comes back.
            const auto_fit_extras_before: AutoFitExtras = {
                owed: pending_auto_fit_sheets_ref.current,
                pendingColumnSnapshots: [...pending_auto_fit_snapshot_ref.current],
            };
            if (undoes_a_fit) update_pending_auto_fit_sheets(EMPTY_PENDING_AUTO_FIT);
            for (const write of writes) {
                pending_auto_fit_snapshot_ref.current[write.sheet_index] = undefined;
            }
            if (post_column_widths_ref.current?.(writes, { replay, auto_fit_extras_before }) !== true) {
                say_wait('refreshing');
            }
            return;
        }
        const header_changes = header_step_changes(entry.action);
        if (header_changes !== undefined && sheets !== undefined) {
            // A header step is replayed through the header queue, like the
            // gesture that made it: the host carries the worksheet's unsaved
            // changes to the restored header in the same durable write.
            // (Keys still owed to a cell, which the fence about to rise would
            // swallow, hold the press before it gets here: `run_edit_command`.)
            const skipped = new Set<ViewSkipReason>();
            const targets = new Map<number, ExcelHeaderTarget>();
            const present: number[] = [];
            for (const { delta: header_delta } of header_changes) {
                const index = worksheet_target_index(sheets, header_delta.worksheet);
                const sheet = index === undefined ? undefined : sheets[index];
                if (index === undefined || sheet === undefined) {
                    skipped.add('sheets-gone');
                    continue;
                }
                present.push(index);
                if (sheet.excelFirstRowHeader === undefined) {
                    skipped.add('header-unavailable');
                    continue;
                }
                // Built from the step, member by member, and never compared
                // with what this window shows: whether anything is left to
                // change is the host's to say. The hidden rows this window
                // holds only predict two outcomes that are skipped here
                // instead of asked for.
                const plan = header_replay_target(header_delta, direction, {
                    sourceRowCount: sheet.sourceRowCount,
                    hiddenRows: in_range_rows(
                        state_ref.current.transforms?.[index]?.hiddenRows,
                        sheet.sourceRowCount,
                    ),
                });
                for (const reason of plan.skipped) skipped.add(reason);
                if (plan.target !== undefined) targets.set(index, plan.target);
            }
            // Refused before the window moves to the step's worksheet: a step
            // that stays where it is leaves the person where they are.
            const refusal = header_change_refusal([...targets.keys()]);
            if (refusal !== undefined) {
                refuse_history_press(view_replay_refusal_warning(direction, entry.action.label, refusal));
                return;
            }
            // Undo shows a worksheet its step belongs to.
            let shown = active_sheet_index;
            if (present.length > 0 && !present.includes(active_sheet_index)) {
                if (!handle_sheet_select(present[0]!)) {
                    say_wait('applying');
                    return;
                }
                shown = present[0]!;
            }
            const named = present.length === 0 ? undefined : sheets[present[0]!];
            const worksheet: WorksheetTarget = named === undefined
                ? header_changes[0]!.delta.worksheet
                : {
                    sheetIndex: present[0]!,
                    sheetName: named.name,
                    ...(named.worksheetId === undefined ? {} : { worksheetId: named.worksheetId }),
                };
            const replay = replay_of(ordered_skips(skipped));
            if (targets.size === 0) {
                // Every worksheet was left out or skipped. The entry moves all
                // the same: a header step never stands in the way of an older
                // step.
                land_view_replay(replay, worksheet, true);
                wake_header_drain();
                return;
            }
            // There is no "already in place" shortcut: a sheet that has a
            // target is always asked for, and if the durable state already
            // holds it the host's write changes nothing and says so.
            enqueue_excel_header_change_ref.current?.({
                enabled: false,
                sheets: [...targets.keys()],
                targets,
                replay,
                worksheet,
                // The result remounts the grid; if it had keyboard focus, it
                // takes it back, so a held Undo keeps arriving at the window.
                ...(grid_focus_ref.current?.has_focus() === true
                    ? { grid_focus_sheet_index: shown }
                    : {}),
            });
            return;
        }
        const change = view_step_change(entry.action);
        if (change === undefined || sheets === undefined) {
            say_unavailable();
            return;
        }
        const delta = change.delta;
        if (delta.slice === 'columnWidths' || delta.slice === 'header') {
            // Unreachable: a width step and a header step are handled above.
            say_unavailable();
            return;
        }
        const index = worksheet_target_index(sheets, delta.worksheet);
        const sheet = index === undefined ? undefined : sheets[index];
        if (index === undefined || sheet === undefined) {
            say_unavailable();
            return;
        }
        const schema = transform_schema_for_sheet(sheet);
        const worksheet: WorksheetTarget = {
            sheetIndex: index,
            sheetName: sheet.name,
            ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
        };
        // Undo shows the worksheet its step belongs to, as a cell undo does,
        // and before anything is posted. The switch is not rolled back if the
        // host then refuses: the message is about that worksheet.
        const show_sheet = (): boolean => {
            if (index === active_sheet_index) return true;
            if (handle_sheet_select(index)) return true;
            say_wait('applying');
            return false;
        };
        if (delta.slice === 'transform') {
            if (preview_mode) {
                say_wait('preview');
                return;
            }
            // Any request pending on this sheet, a restore included: a replay
            // never replaces one. The replaced request's answer would no longer
            // match, and this window would sit on a generation the host has left.
            // It clears by itself (a saved view being re-installed), so the
            // press waits for it, and the drain reads the same ref.
            if (pending_transform_request_ids_ref.current[index] !== undefined) {
                hold_history_press(press, 'updating', { step_wait: { sheet: index } });
                return;
            }
            const live = sanitize_transform_state(
                state_ref.current.transforms?.[index],
                sheet.columnCount,
                schema,
                sheet.sourceRowCount,
            );
            // The rows the Header Row holds, as the host states them: with the
            // header on, every row above it must stay hidden and the header
            // row itself cannot be hidden.
            const header = sheet.excelFirstRowHeader;
            const header_on = header?.mode === 'on';
            const plan = transform_replay_target(delta, direction, live, {
                schema,
                sourceRowCount: sheet.sourceRowCount,
                protectedRows: header_on ? header.sourceRow ?? sheet.sourceRowCount : 0,
                ...(header_on && header.sourceRow !== undefined
                    ? { headerRow: header.sourceRow }
                    : {}),
            });
            const replay = replay_of(plan.skipped);
            // Not reachable walking in order: the insert is a newer step and is
            // undone first, and no transform installs while such rows exist.
            if (
                plan.changes
                && (plan.target.sort.length > 0
                    || plan.target.filters.some((filter) => filter.enabled)
                    || (plan.target.hiddenRows?.length ?? 0) > 0)
            ) {
                for (const [pending_index, store] of
                    edit_session_registry_ref.current?.pending_entries() ?? []) {
                    if (pending_index !== index || !has_inserted_or_moved_rows(store.snapshot())) continue;
                    refuse_history_press(view_replay_refusal_warning(
                        direction,
                        entry.action.label,
                        INSERTED_ROWS_TRANSFORM_MESSAGE,
                    ));
                    return;
                }
            }
            if (!show_sheet()) return;
            if (!plan.changes) {
                // The step's effect is already in place, or all of it was skipped.
                land_view_replay(replay, worksheet, true);
                wake_header_drain();
                return;
            }
            request_transform(index, plan.target, 'user', 'history', {
                worksheet,
                schema,
                baseline: live,
                target: plan.target,
                replay: { ...replay, delta },
            });
            return;
        }
        if (delta.slice === 'rowHeights') {
            // Undo sets each run back to what it held; redo sets every row
            // to the step's height. Posted by source row: this window holds
            // no durable heights, so "already in place" is the host's to
            // say, and its no-op success moves the entry.
            const target = row_heights_replay_target(delta, direction, sheet.sourceRowCount);
            const replay = replay_of(target.skipped);
            if (!show_sheet()) return;
            if (target.rows.length === 0) {
                land_view_replay(replay, worksheet, true);
                wake_header_drain();
                return;
            }
            const request_id = [
                'row-heights',
                highlight_request_prefix_ref.current,
                ++row_resize_request_seq_ref.current,
            ].join(':');
            pending_row_resize_requests_ref.current.set(request_id, {
                sourceGeneration: source_generation_ref.current,
                worksheet,
                gesture: false,
                replay,
            });
            mark_row_height_request(index, request_id);
            sync_view_request_pending();
            watch_view_replay(request_id, direction);
            host_bridge.postMessage({
                type: 'setSourceRowHeights',
                requestId: request_id,
                sheetIndex: index,
                sheetName: sheet.name,
                sourceGeneration: source_generation_ref.current,
                rows: target.rows,
            });
            return;
        }
        // A refresh is being adopted: it clears by itself.
        if (!snapshot_identity_ref.current) {
            hold_history_press(press, 'refreshing', { step_wait: 'identity' });
            return;
        }
        const current = sanitize_column_visibility_state(
            state_ref.current.columnVisibility?.[index],
            sheet.columnCount,
            schema,
        );
        const plan = columns_replay_target(
            delta,
            direction,
            hidden_source_columns(current, sheet.columnCount),
            { schema, columnCount: sheet.columnCount },
        );
        const replay = replay_of(plan.skipped);
        if (!show_sheet()) return;
        if (!plan.changes) {
            land_view_replay(replay, worksheet, true);
            wake_header_drain();
            return;
        }
        const posted = post_column_visibility_ref.current?.(
            index,
            current,
            visibility_from_hidden_columns(plan.hidden, sheet.columnCount, schema),
            replay,
        );
        if (posted !== true) say_wait('refreshing');
    }, [
        active_sheet_index,
        handle_sheet_select,
        header_change_refusal,
        hold_history_press,
        land_view_replay,
        mark_row_height_request,
        preview_mode,
        refuse_history_press,
        request_transform,
        wake_header_drain,
        watch_view_replay,
    ]);

    /**
     * What the window is doing, as a press of Undo or Redo is asked. Read
     * from the refs at this instant; see `history_press_gate`.
     *
     * `without_retry`: the retry that is asking is left out, so it cannot
     * hold itself. For any other press a waiting retry is a replay in flight.
     */
    const read_press_facts = useCallback((without_retry = false): HistoryPressFacts => {
        const row_requests = [...pending_row_resize_requests_ref.current.values()];
        const session_id = csv_edit_session_id_ref.current;
        return {
            reopen_required: reopen_required_ref.current,
            header_reload_required: header_reload_required_ref.current,
            header_change_in_flight: excel_header_queue_ref.current !== null
                || pending_excel_header_ref.current !== null
                || header_run_ref.current !== null
                || header_fence_ref.current,
            replay_in_flight: (replay_coordinator_ref.current?.is_busy() ?? false)
                || pending_row_replay_busy_ref.current
                || pending_view_transforms_ref.current.some((pending) => pending?.replay !== undefined)
                || pending_column_write_ref.current?.replay !== undefined
                || pending_width_write_ref.current?.replay !== undefined
                || row_requests.some((pending) => pending.replay !== undefined)
                || (!without_retry && retry_press_ref.current !== null),
            gesture_in_flight: pending_highlight_request_ref.current !== null
                || row_requests.length > 0
                || pending_append_requests_ref.current.size > 0
                || unsettled_admissions_ref.current.size > 0
                || pending_column_write_ref.current !== null
                || pending_width_write_ref.current !== null
                || (session_id !== undefined
                    && pending_changes_durability.structural_backlog_full(session_id)),
            // The view action counts until the host has settled it, which can be
            // after its install: a press waits for its step (I5).
            view_request_in_flight: view_action_ref.current !== undefined
                || pending_view_transforms_ref.current.some((pending) => pending !== undefined),
            session_gesture_pending: pending_edit_request_ref.current !== null
                || editing_ref.current?.gesture_pending() === true,
            save_in_flight: save_in_flight_ref.current
                || save_projection_ref.current.operation !== undefined,
        };
    }, []);

    /**
     * Carry out a press of Undo or Redo, or hold it.
     *
     * The one way into the coordinator and into a view step's replay.
     * Everything that LANDS a replay is in the committed handler above, driven
     * by the host's answer; this only starts one, holds the press where it
     * cannot start yet, and says why where it cannot start at all.
     *
     * A press that meets something this window itself started is held and
     * carried out when that has cleared (`hold_history_press`,
     * `drain_history_press`). A press never ends here with nothing done and
     * nothing said, except where there was nothing to do: an empty stack, or
     * a document that was replaced under it.
     *
     * It never releases the edit session itself: undo may bring a session back
     * to restore an overlay, and an empty one is released by the same rule as
     * any other (`release_edit_session_if_idle`), not by the replay.
     */
    const run_history_command = useCallback(async (press: HistoryPress): Promise<void> => {
        const direction = press.direction;
        const coordinator = replay_coordinator_ref.current;
        if (coordinator === null) return;
        const replay_document = history_document_ref.current;
        const as_retry = attempting_retry_ref.current !== null;
        // Asked before anything else, whatever is on top of the stack.
        const ask_window = (): boolean => {
            const gate = history_press_gate(read_press_facts(as_retry));
            if (gate.kind === 'run') return true;
            if (gate.kind === 'hold') {
                hold_history_press(press, gate.wait);
                return false;
            }
            // A reopen or a reload is needed: nothing else will clear it.
            refuse_history_press(terminal_gate_message(gate));
            return false;
        };
        if (!ask_window()) return;
        const warn_header_wait = () => {
            const wait = header_wait_ref.current;
            if (wait === null) return;
            // Replay refuses before it would switch to the change's worksheet,
            // so in a workbook with several the message says which one.
            const sheets = meta_ref.current?.sheets ?? [];
            const index = worksheet_target_index(sheets, wait.worksheet);
            const sheet_name = sheets.length > 1
                ? (index === undefined ? undefined : sheets[index]?.name) ?? wait.worksheet.sheetName
                : undefined;
            refuse_history_press(header_wait_warning(wait, direction, sheet_name));
        };
        /** Undo has run into a barrier: say which, as the coordinator's refusal would. */
        const say_blocked = () => {
            const barrier = history_store_ref.current?.snapshot().barrier;
            refuse_history_press(history_refusal_warning('blocked', direction, barrier?.label, barrier?.reason));
        };
        let initial = peek_history(history_store_ref.current!.snapshot(), direction);
        if (initial.kind === 'available' && action_has_view_change(initial.entry.action)) {
            // This window's editing session is on its way out (a release or a
            // Discard; both raise the same fence). Undoing the last unsaved edit
            // releases the session, and until the host has finished, its
            // transform admission answers "try again in a moment". A person
            // holding Undo to walk back through an edit and then a sort must
            // not get that as a dialog, so the press is held until the session
            // id clears or the next snapshot is applied. Holding it also holds
            // off the idle-session release, which is safe: the fence is only
            // ever raised together with the release or discard post, so that
            // is already on its way.
            //
            // A size step does not wait: the wait exists because the host's
            // transform admission refuses while a session is released, and a
            // width or row-height write passes no such admission.
            if (!action_is_size_step(initial.entry.action)) {
                const gate = view_step_press_gate({
                    session_id: csv_edit_session_id_ref.current,
                    fenced_session_id: renderer_publication_fenced_session_ref.current,
                    applied_snapshot_seq: applied_snapshot_seq_ref.current,
                    release_seq: press.release_seq,
                });
                if (gate.kind === 'hold') {
                    hold_history_press(press, gate.wait);
                    return;
                }
            }
            // Fold the open editor first: committing it records a cell edit,
            // and Undo means the top entry after that commit. The fold is
            // part of the press, so it passes a gate that a retry of this
            // same press may be holding shut.
            const fold = with_gesture_ticket(0, () => fold_before_view_request(say_history));
            if (fold === 'refused') {
                // `fold_before_view_request` has said why.
                refuse_history_press(null);
                return;
            }
            // What the commit left to replay is read first: a press held
            // below would come back to an empty redo stack and say nothing.
            initial = peek_history(history_store_ref.current!.snapshot(), direction);
            if (initial.kind !== 'available') {
                if (initial.kind === 'blocked') {
                    // The commit was too large to keep in history, which
                    // cleared both stacks behind a barrier.
                    say_blocked();
                } else if (direction === 'redo' && fold === 'folded') {
                    // The commit cleared the redo stack.
                    refuse_history_press(REDO_REPLACED_BY_FOLD_MESSAGE);
                }
                return;
            }
            // The checks run on the state the fold left: the row a committed
            // edit grew is being measured, and the press waits for it.
            if (!ask_window()) return;
            if (action_has_view_change(initial.entry.action)) {
                replay_view_step(initial.entry, press);
                return;
            }
            // Otherwise the top is the edit just committed: the ordinary path.
        }
        /**
         * What the coordinator's refusal means for the press. `barrier` was
         * read before the replay: a `blocked` refusal is about the barrier
         * that was in the way, and the stack may move under the await.
         */
        const answer_refusal = (
            outcome: ReplayOutcome,
            barrier: HistoryBarrier | undefined,
            // The entry the refused replay was for: a retry runs only while
            // it is still on top.
            entry: HistoryEntry | undefined,
        ) => {
            if (outcome.kind !== 'refused') return;
            switch (outcome.reason) {
                case 'nothing-to-replay':
                    // The press was carried out, and there was nothing to
                    // carry out. The menu item names no step.
                    return;
                case 'busy':
                    // Another replay took the slot first.
                    hold_history_press(press, 'applying');
                    return;
                case 'view-step':
                    // A sort of this window installed, and recorded, while
                    // the cell replay under it was acquiring its session.
                    // The press is for the newest entry: start again.
                    void run_history_command_ref.current(press);
                    return;
                case 'header-row':
                    warn_header_wait();
                    return;
                case 'not-current': {
                    // The host's view had moved and the host wrote nothing.
                    // Tried again once the refresh it lost to is here.
                    if (entry !== undefined) {
                        hand_over_history_retry(press, entry, replay_posted_after_ref.current, 'delivery');
                        return;
                    }
                    break;
                }
                default:
                    break;
            }
            refuse_history_press(history_refusal_warning(
                outcome.reason,
                direction,
                barrier?.label,
                barrier?.reason,
            ));
        };
        // From here the press asks the host, and waits for each answer. If the
        // attempt has not ended after as long as a lease lasts, the press says
        // so: a request the host never answers keeps its reservation, and the
        // press that started it must not have changed nothing and said nothing.
        const watch = window.setTimeout(() => {
            if (history_document_ref.current !== replay_document) return;
            say_history(history_unanswered_warning(direction));
        }, HISTORY_REPLAY_LEASE_TTL_MS);
        try {
            // Before a session is acquired for it: a change that has no form under
            // the current Header Row says so and stays where it is.
            if (initial.kind === 'available' && entry_for_replay_ref.current(initial.entry) === undefined) {
                warn_header_wait();
                return;
            }
            if (
                initial.kind === 'available'
                && initial.entry.action.changes.some((change) =>
                    is_structural_history_change(change))
            ) {
                pending_row_replay_busy_ref.current = true;
                let structural_outcome: {
                    readonly outcome: ReplayOutcome;
                    readonly barrier: HistoryBarrier | undefined;
                    readonly entry: HistoryEntry;
                } | undefined;
                const restoration_settlements: ((accepted: boolean) => void)[] = [];
                const restoration_request_ids: string[] = [];
                const restoration_bases = new Map<string, PendingAppendBasis>();
                let restorations_handed_off = false;
                let restorations_accepted = false;
                try {
                    const replay_session_ready = await (
                        ensure_replay_session_ref.current?.() ?? Promise.resolve(false)
                    );
                    if (history_document_ref.current !== replay_document) return;
                    if (!replay_session_ready) {
                        refuse_history_press(history_session_unavailable_warning(direction));
                        return;
                    }
                    // Session acquisition can hydrate stores and can let a newer
                    // gesture land. Undo always means the top entry after that
                    // boundary, so re-read and only take the local path if it is
                    // still structural.
                    const current = peek_history(history_store_ref.current!.snapshot(), direction);
                    if (current.kind !== 'available') {
                        // Undo: a save's receipt landed meanwhile and set its
                        // barrier. Redo: a new action cleared what there was.
                        if (current.kind === 'blocked') say_blocked();
                        return;
                    }
                    // Planned from the entry as it reads under the current Header
                    // Row; history moves the stored entry, `current.entry`.
                    const replay_entry = entry_for_replay_ref.current(current.entry);
                    if (replay_entry === undefined) {
                        warn_header_wait();
                        return;
                    }
                    const sheets = meta_ref.current?.sheets;
                    const session_id = csv_edit_session_id_ref.current;
                    if (sheets === undefined || session_id === undefined) {
                        refuse_history_press(history_session_unavailable_warning(direction));
                        return;
                    }
                    const restoration_groups = new Map<string, {
                        worksheet: WorksheetTarget;
                        ids: string[];
                    }>();
                    for (const change of replay_entry.action.changes) {
                        if (
                            change.kind !== 'rowAppend'
                            || change.delta.restoredFromSavedRemoval !== true
                        ) continue;
                        const desired = direction === 'undo'
                            ? change.delta.before
                            : change.delta.after;
                        if (desired === null) continue;
                        const key = worksheet_target_key(change.delta.worksheet);
                        const group = restoration_groups.get(key) ?? {
                            worksheet: change.delta.worksheet,
                            ids: [],
                        };
                        group.ids.push(change.delta.pendingRowId);
                        restoration_groups.set(key, group);
                    }
                    for (const { worksheet, ids } of restoration_groups.values()) {
                        const sheet_index = worksheet_target_index(sheets, worksheet);
                        if (sheet_index === undefined) {
                            // The worksheet the rows were saved on is gone.
                            refuse_history_press(history_refusal_warning('unavailable', direction, undefined));
                            return;
                        }
                        const source_generation = source_generation_ref.current;
                        const request_id = [
                            'restore-saved-rows',
                            ++restore_saved_rows_seq_ref.current,
                        ].join(':');
                        const admission = await new Promise<{
                            readonly requestId: string;
                            readonly appendBasis: PendingAppendBasis;
                            readonly settle: (accepted: boolean) => void;
                        } | undefined>((resolve) => {
                            pending_saved_row_restorations_ref.current.set(request_id, {
                                sourceGeneration: source_generation,
                                expectedIds: [...ids],
                                sheetIndex: sheet_index,
                                editSessionId: session_id,
                                resolve,
                            });
                            host_bridge.postMessage({
                                type: 'requestRestoreSavedRows',
                                requestId: request_id,
                                editSessionId: session_id,
                                worksheet,
                                sourceGeneration: source_generation,
                                appendHistoryIds: ids,
                            });
                        });
                        if (history_document_ref.current !== replay_document) return;
                        if (admission === undefined) {
                            refuse_history_press('The saved appended rows could not be restored.');
                            return;
                        }
                        restoration_settlements.push(admission.settle);
                        restoration_request_ids.push(admission.requestId);
                        restoration_bases.set(
                            worksheet_target_key(worksheet),
                            admission.appendBasis,
                        );
                    }
                    let planned = plan_pending_row_history_replay(
                        replay_entry.action,
                        direction,
                        (worksheet) => {
                            const sheet_index = worksheet_target_index(sheets, worksheet);
                            return sheet_index === undefined
                                ? undefined
                                : edit_session_registry_ref.current!
                                    .pending_rows_for_sheet(sheet_index)
                                    .snapshot();
                            },
                    );
                    if (planned.kind === 'plan' && restoration_bases.size > 0) {
                        let invalid_basis = false;
                        const plans = planned.plans.map((plan): PendingRowHistoryPlan => {
                            const admitted = restoration_bases.get(
                                worksheet_target_key(plan.worksheet),
                            );
                            if (admitted === undefined) return plan;
                            const advanced = plan.next.appendBasis === undefined
                                ? admitted
                                : advance_pending_append_basis(
                                    plan.next.appendBasis,
                                    admitted,
                                );
                            if (advanced === undefined) {
                                invalid_basis = true;
                                return plan;
                            }
                            return {
                                ...plan,
                                next: { ...plan.next, appendBasis: advanced },
                            };
                        });
                        planned = invalid_basis
                            ? { kind: 'refused', reason: 'conflict' }
                            : { kind: 'plan', plans };
                    }
                    if (planned.kind === 'not-structural') {
                        // A different action landed during acquisition; release the
                        // local reservation and let the ordinary coordinator handle
                        // that action below.
                    } else if (planned.kind === 'refused') {
                        refuse_history_press(
                            direction === 'undo'
                                && current.entry.action.changes.some(
                                    (change) => change.kind === 'tailRemoval',
                                )
                                ? "Can't undo appended rows because the worksheet changed after they were saved."
                                : 'The pending rows changed, so this history action could not be replayed.',
                        );
                        return;
                    } else {
                        // A saved append can become a prospective removal only while
                        // every row in question is still part of the physical suffix.
                        // The save planner repeats this against fresh file bytes and
                        // fingerprints; this immediate check keeps an obviously-grown
                        // worksheet from appearing to accept the undo meanwhile.
                        const suffix_is_safe = planned.plans.every((plan) => {
                            // Undoing a saved append on a worksheet with a layout
                            // change is refused: both assume the source rows keep
                            // their physical place.
                            if (
                                plan.next.tailRemovals.length > 0
                                && has_live_layout_change(plan.next)
                            ) return false;
                            const sheet_index = worksheet_target_index(sheets, plan.worksheet);
                            if (sheet_index === undefined) return false;
                            const source_row_count = sheets[sheet_index]?.sourceRowCount;
                            if (source_row_count === undefined) return false;
                            return plan.next.tailRemovals.every(
                                (removal, index, removals) => removal.sourceRow
                                    === source_row_count - removals.length + index,
                            );
                        });
                        if (!suffix_is_safe) {
                            refuse_history_press(
                                "Can't undo appended rows because the worksheet changed after they were saved.",
                            );
                            return;
                        }
                        const removals_to_validate = planned.plans.flatMap((plan) => {
                            const expected_ids = new Set(plan.expected.tailRemovals.map(
                                (removal) => removal.appendHistoryId,
                            ));
                            const added_removals = plan.next.tailRemovals.filter(
                                (removal) => !expected_ids.has(removal.appendHistoryId),
                            );
                            return added_removals.length === 0 ? [] : [{
                                ...plan.worksheet,
                                // Host validation proves the complete prospective
                                // suffix, including removals staged by earlier Undos.
                                removals: plan.next.tailRemovals.map(({
                                    appendHistoryId,
                                    sourceRow,
                                    savedFingerprint,
                                }) => ({
                                    appendHistoryId,
                                    sourceRow,
                                    savedFingerprint,
                                })),
                            }];
                        });
                        if (removals_to_validate.length > 0) {
                            const source_generation = source_generation_ref.current;
                            const request_id = [
                                'tail-removal-validation',
                                ++tail_removal_validation_seq_ref.current,
                            ].join(':');
                            const valid = await new Promise<boolean>((resolve) => {
                                pending_tail_removal_validations_ref.current.set(request_id, {
                                    sourceGeneration: source_generation,
                                    resolve,
                                });
                                host_bridge.postMessage({
                                    type: 'validateTailRemovalReplay',
                                    requestId: request_id,
                                    editSessionId: session_id,
                                    sourceGeneration: source_generation,
                                    worksheets: removals_to_validate,
                                });
                            });
                            if (history_document_ref.current !== replay_document) return;
                            if (!valid) {
                                refuse_history_press(
                                    "Can't undo appended rows because the worksheet changed after they were saved.",
                                );
                                return;
                            }
                        }
                        pending_row_replay_plan_ref.current = {
                            entryId: current.entry.id,
                            direction,
                            plans: planned.plans,
                            restorationRequestIds: Object.freeze([
                                ...restoration_request_ids,
                            ]),
                            settleRestorations: restoration_settlements,
                        };
                        restorations_handed_off = true;
                        const barrier = history_store_ref.current?.snapshot().barrier;
                        const outcome = await coordinator.begin(direction);
                        if (history_document_ref.current !== replay_document) return;
                        structural_outcome = { outcome, barrier, entry: current.entry };
                        return;
                    }
                } finally {
                    if (!restorations_handed_off && !restorations_accepted) {
                        restoration_settlements.forEach((settle) => settle(false));
                    }
                    const replay = pending_row_replay_plan_ref.current;
                    if (replay !== null && replay.settleRestorations === restoration_settlements) {
                        replay.settleRestorations.forEach((settle) => settle(false));
                    }
                    pending_row_replay_busy_ref.current = false;
                    pending_row_replay_plan_ref.current = null;
                    // Answered only now, with the reservation released: a press
                    // that starts again, or is tried again, must find it free.
                    if (structural_outcome !== undefined) {
                        answer_refusal(
                            structural_outcome.outcome,
                            structural_outcome.barrier,
                            structural_outcome.entry,
                        );
                    }
                }
            }
            // Read BEFORE the replay: a `blocked` refusal is about the barrier that was
            // in the way, and the stack may move under the await.
            const barrier = history_store_ref.current?.snapshot().barrier;
            // The entry the coordinator replays: nothing can be recorded
            // while its replay is out, so the top now is the one it takes.
            const replayed = peek_history(history_store_ref.current!.snapshot(), direction);
            const outcome = await coordinator.begin(direction);
            if (history_document_ref.current !== replay_document) return;
            answer_refusal(outcome, barrier, replayed.kind === 'available' ? replayed.entry : undefined);
        } finally {
            window.clearTimeout(watch);
            // A restore of the saved view that stepped aside for the attempt
            // is asked about again.
            if (restore_waits_for_replay_ref.current) {
                restore_waits_for_replay_ref.current = false;
                set_restore_wake((wake) => wake + 1);
            }
            // An attempt that ended renders nothing by itself; a press held
            // behind it, and a queued header change, wait on it.
            wake_header_drain();
        }
    }, [
        fold_before_view_request,
        hand_over_history_retry,
        hold_history_press,
        read_press_facts,
        refuse_history_press,
        replay_view_step,
        say_history,
        wake_header_drain,
        with_gesture_ticket,
    ]);
    run_history_command_ref.current = run_history_command;

    /**
     * A press of Undo or Redo, from the keyboard or the Edit menu: the one
     * way a press is made.
     *
     * While a press is already waiting, a press in the same direction is the
     * same request and changes nothing: a held key sends a press every 30 ms
     * or so, and counted presses would go on undoing after the key was let
     * go. A press in the other direction cancels the one waiting: Undo then
     * Redo, both pressed before either could run, is nothing.
     *
     * `handed_on` is a press that was held for typed keys and is now sent on
     * (see the drain): it is attempted as it is, with the `started` and the
     * `epoch` it was given when the key was pressed.
     */
    const press_history = useCallback((direction: HistoryDirection, handed_on?: HistoryPress) => {
        if (handed_on === undefined) perf_mark('tv:press', { direction });
        if (handed_on !== undefined) {
            void run_history_command(handed_on);
            return;
        }
        const held = held_press_ref.current;
        if (held !== null) {
            if (held.press.direction !== direction) {
                held_press_ref.current = null;
                arm_history_press_timer();
            }
            return;
        }
        // Undo of the person's own view request still in flight cancels it,
        // back to the rules from before it (I4). The press is used up and makes
        // no step. Not when a header run is waiting or running: that is newer
        // than the request, and the press waits for it, as today. Not under the
        // reopen fence, which refuses the press with its message below.
        const pending_action = view_action_ref.current;
        if (
            direction === 'undo'
            && pending_action !== undefined
            && !pending_action.action.cancelled
            && !reopen_required_ref.current
            && excel_header_queue_ref.current === null
            && pending_excel_header_ref.current === null
            && header_run_ref.current === null
            && !cancel_blocked_ref.current()
        ) {
            cancel_view_action_ref.current(pending_action.action.sheetIndex);
            return;
        }
        void run_history_command({
            direction,
            started: Date.now(),
            epoch: press_epoch_ref.current += 1,
        });
    }, [arm_history_press_timer, run_history_command]);

    /**
     * A press made while keys typed at a cell are still on their way into an
     * editor (held for a session or an appended row, or their editor has not
     * mounted yet). A moment later the same press would be that editor's own
     * text undo, so it waits for that moment. This hold reserves nothing: the
     * keys must reach their editor, and its commit must be admitted.
     */
    const hold_history_press_for_typing = useCallback((direction: HistoryDirection) => {
        const held = held_press_ref.current;
        if (held !== null) {
            if (held.press.direction !== direction) {
                held_press_ref.current = null;
                arm_history_press_timer();
            }
            return;
        }
        hold_history_press(
            { direction, started: Date.now(), epoch: press_epoch_ref.current += 1 },
            'applying',
            { typing: true },
        );
    }, [arm_history_press_timer, hold_history_press]);

    /** `run_edit_command`, which is declared further down. */
    const run_edit_command_ref = useRef<(command: EditCommand, handed_on?: HistoryPress) => void>(() => {});

    /**
     * Carry out a waiting press if what it waits for has cleared, or end it
     * with its message if its bound has passed.
     *
     * After every render, like the header queue's drain. Everything a press
     * waits for either changes state when it ends, which renders, or calls
     * `wake_history_press`; and the bound's timer renders at the bound.
     *
     * The retry is looked at before the held press, and stays in its own slot
     * until its attempt has posted a request, moved its entry, or been
     * answered with a message, so it cannot replace the press behind it.
     */
    const drain_history_press = () => {
        if (draining_history_press_ref.current) return;
        if (held_press_ref.current === null && retry_press_ref.current === null) return;
        draining_history_press_ref.current = true;
        try {
            const step_wait_clear = (step_wait: HeldPress['step_wait']): boolean => {
                if (step_wait === undefined) return true;
                if (step_wait === 'identity') return snapshot_identity_ref.current !== null;
                return pending_transform_request_ids_ref.current[step_wait.sheet] === undefined;
            };
            const releasing = (press: HistoryPress): boolean => view_step_press_gate({
                session_id: csv_edit_session_id_ref.current,
                fenced_session_id: renderer_publication_fenced_session_ref.current,
                applied_snapshot_seq: applied_snapshot_seq_ref.current,
                release_seq: press.release_seq,
            }).kind === 'hold';
            const retry = retry_press_ref.current;
            if (retry !== null) {
                const direction = retry.press.direction;
                const give_up = () => {
                    // The press behind it was for the stack as the retry
                    // would have left it (a typing hold is not: see
                    // `refuse_history_press`).
                    retry_press_ref.current = null;
                    if (held_press_ref.current?.typing !== true) held_press_ref.current = null;
                    arm_history_press_timer();
                    say_history(view_replay_wait_warning('refreshing', direction));
                };
                const arrived = (retry.awaits === 'delivery'
                    ? snapshot_applied_seq_ref.current
                    : applied_snapshot_seq_ref.current) > retry.posted_after;
                const gate = history_press_gate(read_press_facts(true));
                if (gate.kind === 'reload-required' || gate.kind === 'reopen-required') {
                    // A reopen or a reload is needed: nothing else will clear
                    // it, and that, not a refresh, is what to say.
                    retry_press_ref.current = null;
                    arm_history_press_timer();
                    refuse_history_press(terminal_gate_message(gate));
                } else if (history_press_bound_reached(retry.press, Date.now())) {
                    give_up();
                } else if (!arrived) {
                    // A view replay with no snapshot applied since its post:
                    // nothing says a refresh is coming. A cell or structural
                    // replay waits for the delivery its refusal says is on
                    // its way, until the bound.
                    if (retry.awaits === 'applied') give_up();
                } else if (
                    history_press_gate(read_press_facts(true)).kind === 'run'
                    && !(action_has_view_change(retry.entry.action)
                        && !action_is_size_step(retry.entry.action)
                        && releasing(retry.press))
                    && step_wait_clear(retry.step_wait)
                ) {
                    const top = peek_history(history_store_ref.current!.snapshot(), direction);
                    if (top.kind !== 'available' || top.entry !== retry.entry) {
                        // Something else is on top now.
                        give_up();
                    } else {
                        attempting_retry_ref.current = retry;
                        try {
                            // The press itself passes the gate its own
                            // retry holds shut.
                            void with_gesture_ticket(0, () => run_history_command(retry.press));
                        } finally {
                            attempting_retry_ref.current = null;
                        }
                        // Not held again: it posted, landed, or was answered.
                        if (retry_press_ref.current === retry) {
                            retry_press_ref.current = null;
                            arm_history_press_timer();
                        }
                    }
                }
                // Otherwise it is left where it is. Nothing was written, so
                // nothing wakes; the settling of what it waits for, or the
                // timer at the bound, comes next.
            }
            const held = held_press_ref.current;
            if (held === null) return;
            const { press } = held;
            const bound_reached = history_press_bound_reached(press, Date.now());
            if (held.typing === true) {
                if (editing_ref.current?.typing_pending() !== true) {
                    // The keys have landed. With their editor open and
                    // focused this is its own text undo; if nothing opened it
                    // is an ordinary press, still the one that was made.
                    held_press_ref.current = null;
                    arm_history_press_timer();
                    run_edit_command_ref.current(press.direction, press);
                } else if (bound_reached) {
                    // Not made into an ordinary press: the editor those keys
                    // are for would open after it, and the press could not
                    // be put in order with typing that came before it.
                    held_press_ref.current = null;
                    arm_history_press_timer();
                    say_history(view_replay_wait_warning('applying', press.direction));
                }
                return;
            }
            const gate = history_press_gate(read_press_facts());
            const waiting: HistoryPressWait | undefined = gate.kind === 'hold'
                ? gate.wait
                : gate.kind === 'run' && held.wait === 'finishing' && releasing(press)
                    ? 'finishing'
                    : gate.kind === 'run' && !step_wait_clear(held.step_wait)
                        ? held.wait
                        : undefined;
            if (waiting !== undefined) {
                if (bound_reached) {
                    held_press_ref.current = null;
                    arm_history_press_timer();
                    say_history(view_replay_wait_warning(waiting, press.direction));
                } else if (waiting !== held.wait) {
                    held_press_ref.current = { ...held, wait: waiting };
                }
                return;
            }
            // Clear (or a fence that needs a reload, or a window that must be
            // reopened, which the attempt says):
            // a press made at this instant, which peeks the stack as it is.
            held_press_ref.current = null;
            arm_history_press_timer();
            void run_history_command(press);
        } finally {
            draining_history_press_ref.current = false;
            // Whatever still waits keeps a timer for its bound. One that fired
            // early (a timer and the wall clock can disagree) found the bound
            // not reached and would otherwise leave the press with no answer
            // until some other render. Arming writes no state.
            if (held_press_ref.current !== null || retry_press_ref.current !== null) {
                arm_history_press_timer();
            }
        }
    };
    useEffect(() => {
        drain_history_press();
    });
    useEffect(() => () => {
        window.clearTimeout(history_press_timer_ref.current);
        unwatch_view_replay();
    }, [unwatch_view_replay]);

    /**
     * Undo and redo from the keyboard, for the VS Code webview.
     *
     * Capture phase, because Glide consumes key events on the way up and would
     * eat these before a bubbling listener saw them.
     *
     * A text target is left entirely alone — not prevented, not stopped, not
     * acted on — so the browser's own text undo runs inside an open cell editor.
     * That is decision 4, and here it costs nothing but an early return; on the
     * desktop the same rule has to be enforced in `run_edit_command`, because the
     * OS eats the accelerator before this listener could ever run.
     *
     * Key repeat is not filtered. Holding the chord down to walk back a run of
     * edits is how the feature is used: a repeat that arrives while a step is
     * still out is held, and carried out when that step has landed.
     */
    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            const command = history_hotkey_command(event);
            if (command === undefined) return;
            const target = event.target instanceof Element ? event.target : document.activeElement;
            if (edit_command_target(target) === 'text') return;
            event.preventDefault();
            event.stopPropagation();
            // Typed for an editor not open yet, where it would undo text.
            if (editing_ref.current?.typing_pending()) {
                hold_history_press_for_typing(command);
                return;
            }
            press_history(command);
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [hold_history_press_for_typing, press_history]);

    /**
     * Route the host's replay answers to the coordinator, and land a committed one.
     *
     * Its own effect rather than a branch in an existing handler: those handlers'
     * dependency arrays already run to dozens of entries, and a replay needs none
     * of what they close over.
     */
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;
            const coordinator = replay_coordinator_ref.current;
            if (coordinator === null) return;
            switch (msg.type) {
                case 'historyReplayPrepared':
                    coordinator.on_prepared(msg.prepared);
                    return;
                case 'historyReplayPrepareRefused':
                    coordinator.on_prepare_refused(msg.refusal);
                    return;
                case 'historyReplayCommitted': {
                    // Apply only what the coordinator ACCEPTED, and only the entry
                    // it accepted for: a stale correlation returns undefined here
                    // rather than letting this handler decide on its own.
                    const accepted = coordinator.on_committed(msg.committed);
                    if (accepted === undefined) return;
                    handle_committed_history_replay(accepted);
                    return;
                }
                case 'historyReplayCommitRefused':
                    coordinator.on_commit_refused(msg.refusal);
                    return;
                default:
                    return;
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [handle_committed_history_replay]);


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

    // ---- Find (docs/superpowers/specs/2026-11-12-find-in-cells-design.md) ----
    // App owns the bar's state because transforms and sheet switches remount
    // GridShell; the scan lives in GridShell behind GridActionsHandle.find.
    const [find_open, set_find_open] = useState(false);
    const [find_query, set_find_query] = useState('');
    const [find_status, set_find_status] = useState<FindStatus>('idle');
    const [find_focus_request, set_find_focus_request] = useState(0);
    const find_bar_ref = useRef<FindBarHandle>(null);
    // Only the latest search may write the status.
    const find_sequence_ref = useRef(0);
    const run_find = useCallback((
        query: string,
        direction: FindDirection,
        inclusive: boolean,
    ) => {
        const sequence = ++find_sequence_ref.current;
        const handle = grid_actions_ref.current;
        if (query === '' || !handle || handle.sheet_index !== active_sheet_index) {
            handle?.cancel_find();
            set_find_status('idle');
            return;
        }
        set_find_status('searching');
        handle.find(query, direction, inclusive).then((result) => {
            if (find_sequence_ref.current !== sequence) return;
            set_find_status(result.kind === 'none' ? 'none' : 'idle');
        }, (error: unknown) => {
            console.error('Find failed', error);
            if (find_sequence_ref.current === sequence) set_find_status('idle');
        });
    }, [active_sheet_index]);
    // Opening Find folds an open cell editor first, so its text is searchable
    // and no overlay is left behind when a match moves the selection. A refused
    // commit keeps the editor open and the bar closed.
    const open_find = useCallback(() => {
        if (editing_ref.current?.commit_live_edit() === false) return;
        set_find_open(true);
        set_find_focus_request((request) => request + 1);
    }, []);
    const close_find = useCallback(() => {
        find_sequence_ref.current += 1;
        grid_actions_ref.current?.cancel_find();
        set_find_open(false);
        set_find_status('idle');
        grid_focus_ref.current?.focus();
    }, []);
    useEffect(() => {
        if (find_focus_request > 0) find_bar_ref.current?.focus_and_select();
    }, [find_focus_request]);
    // A remount (sheet switch, reload, transform) ends any running scan; the
    // query stays, the status clears.
    useEffect(() => {
        find_sequence_ref.current += 1;
        set_find_status('idle');
    }, [active_sheet_index, generation, load_epoch]);
    // Capture phase, like the undo listener above: Glide consumes key events on
    // the way up. Stopping the chord here also keeps it from VS Code's workbench.
    // On the desktop the Edit menu's accelerator claims it first and arrives as
    // an `editCommand` instead.
    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (!is_find_hotkey(event)) return;
            event.preventDefault();
            event.stopPropagation();
            open_find();
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [open_find]);

    // Copy / Select All arriving from a host menu that owns the keyboard
    // shortcut (the desktop app's native Edit menu). Whatever has focus decides:
    // the CSV cell editor's text field, otherwise the grid.
    const run_edit_command = useCallback((
        command: EditCommand,
        // A press that was held for typed keys and is sent on by the drain.
        handed_on?: HistoryPress,
    ) => {
        // Before the text-field branch: Find opens from a cell editor too,
        // rather than copying the field.
        if (command === 'find') {
            open_find();
            return;
        }
        const active = document.activeElement;
        if (edit_command_target(active) === 'text') {
            // Decision 4, and the whole reason undo comes through here: inside an
            // open cell editor Cmd/Ctrl+Z is the browser's text undo, not the
            // workbook's. The OS consumed the accelerator before the page saw it,
            // so this focus check is the only place that distinction can be made.
            if (command === 'undo' || command === 'redo') {
                run_native_text_history(command);
                return;
            }
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
        if (command === 'undo' || command === 'redo') {
            // Typed for an editor not open yet, where it would undo text.
            if (handed_on === undefined && editing_ref.current?.typing_pending()) {
                hold_history_press_for_typing(command);
                return;
            }
            press_history(command, handed_on);
            return;
        }
        const handle = grid_actions_ref.current;
        if (command === 'selectAll') handle?.select_all();
        else handle?.copy_selection();
    }, [hold_history_press_for_typing, open_find, press_history]);
    run_edit_command_ref.current = run_edit_command;

    /**
     * The only writer besides a snapshot, which installs both, so the live
     * array and the persisted copy cannot drift.
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

    /**
     * Whether a header request would race a display projection.
     *
     * Every transform install can advance the workbook generation, including one
     * on a sibling sheet. A row promotion has the additional requirement that its
     * target sheet's durable rules are installed: `headerRow` is display-keyed, so
     * sending it against the natural view while a hidden-row restore is still owed
     * names a different source row at the host.
     *
     * `count_in_flight` false asks only about the rules installed now, for the
     * row menu, which shows a transform in flight as disabled rather than absent.
     */
    const header_waits_for_transform = useCallback((
        target_sheet_index: number,
        display_keyed: boolean,
        count_in_flight = true,
    ) => {
        if (
            count_in_flight
            && (pending_transform_request_ids_ref.current.some(Boolean)
                || pending_transforms.some(Boolean))
        ) return true;
        if (!display_keyed) return false;
        const sheet = meta?.sheets[target_sheet_index];
        if (!sheet) return false;
        const installed = sheet_views[target_sheet_index];
        const installed_rules = installed?.permuted
            ? installed.rules
            : undefined;
        if (
            (installed_rules?.sort.length ?? 0) > 0
            || installed_rules?.filters.some((filter) => filter.enabled)
        ) return true;
        // A terminal refusal adopts the view already on screen and deliberately
        // stops restoration for this row basis. With no installed sort or active
        // filter above, that view is safe to address by display row even though the
        // durable rules no longer reconcile with it.
        if (restore_abandoned_ref.current[target_sheet_index]) return false;
        const durable = sanitize_transform_state(
            state_ref.current.transforms?.[target_sheet_index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
            sheet.sourceRowCount,
        );
        return transform_reconciliation_required(durable, installed);
    }, [meta, pending_transforms, sheet_views, transforms]);

    const request_excel_header = useCallback((
        enabled: boolean,
        unhide_all = false,
        header_row?: number,
        // The host keys the request by sheet, so an inactive sheet is addressable
        // without switching to it — which is what lets "all sheets" run as a queue
        // rather than as a tour of the workbook.
        target_sheet_index = active_sheet_index,
        // The sheet whose grid should regain focus after an authoritative remount.
        // Undefined for grid- and state-strip-originated header commands.
        grid_focus_sheet_index?: number,
        // A header step's replay: the header state to install, by source row.
        // Not display-keyed, so only the wait for a transform request in
        // flight applies to it.
        target?: ExcelHeaderTarget,
    ) => {
        const sheet = meta?.sheets[target_sheet_index];
        const header = sheet?.excelFirstRowHeader;
        // Every header affordance funnels through here, from the header queue's
        // drain: the primary toggle, row promotion, Unhide all for a promoted
        // header, and the all-sheets queue. Under an editing session the drain
        // has raised the header fence, published every store, and waited for
        // the host to hold it all, so the host can carry the session's Pending
        // Changes to the new Header Row in the same write. Keep the fence check
        // at this shared boundary too, so a stale callback cannot bypass it.
        if (!sheet || !header) return 'skip';
        if (
            ((editing_session_held || editing_session_held_ref.current) && !header_fence_ref.current)
            || (
                header_row !== undefined
                && (preview_mode || preview_mode_ref.current)
            )
            || pending_excel_header_ref.current
            || header_waits_for_transform(
                target_sheet_index,
                header_row !== undefined,
            )
        ) return 'wait';
        const request_id = `header:${excel_header_request_prefix_ref.current}:${
            ++excel_header_request_seq_ref.current
        }`;
        pending_excel_header_ref.current = request_id;
        if (grid_focus_sheet_index !== undefined) {
            pending_excel_header_grid_focus_ref.current.set(
                request_id,
                grid_focus_sheet_index,
            );
        }
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
            enabled: target === undefined ? enabled : target.mode === 'on',
            ...(unhide_all ? { unhideAll: true } : {}),
            ...(header_row !== undefined ? { headerRow: header_row } : {}),
            ...(target === undefined ? {} : { target }),
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
        });
        return 'posted';
    }, [
        active_sheet_index,
        editing_session_held,
        header_waits_for_transform,
        meta,
        preview_mode,
    ]);

    /**
     * Header Row changes still owed, and the state to put each sheet in.
     *
     * The host takes one at a time, so "all sheets" is a queue drained one sheet
     * per result rather than a burst. Sheets already in the target state never
     * enter it. The ref is the truth the drain reads; the state re-renders.
     */
    const [excel_header_queue, set_excel_header_queue] = useState<ExcelHeaderQueue | null>(null);
    const excel_header_queue_ref = useRef<ExcelHeaderQueue | null>(null);
    const replace_excel_header_queue = useCallback((next: ExcelHeaderQueue | null) => {
        excel_header_queue_ref.current = next;
        set_excel_header_queue(next);
    }, []);
    /** The request posted for the queue's head sheet, until its result arrives. */
    const header_in_flight_ref = useRef<{
        readonly queue: ExcelHeaderQueue;
        readonly sheet: ExcelHeaderQueueSheet;
        readonly posted_snapshot: number;
        /** The worksheet the request was posted for, for its step's change. */
        readonly worksheet: WorksheetTarget;
    } | null>(null);
    const header_timer_refs = useRef<ReturnType<typeof setTimeout>[]>([]);
    const schedule_header_wake = useCallback((delay: number) => {
        header_timer_refs.current.push(setTimeout(wake_header_drain, Math.max(0, delay)));
    }, [wake_header_drain]);
    useEffect(() => pending_changes_durability.on_acknowledged(wake_header_drain), [wake_header_drain]);
    useEffect(() => () => {
        for (const timer of header_timer_refs.current) clearTimeout(timer);
    }, []);

    /**
     * The header fence: from the gesture that asks for a Header Row change until
     * its last result, no edit gesture is admitted and no cell editor opens. The
     * host moves the session's Pending Changes with the header in one write, so
     * nothing may be authored against the old Header Row once the drain has
     * published every store; and the drain may not post until the host holds
     * all of it. Reversible and separate from the close barrier's latch.
     */
    const lower_header_fence = useCallback(() => {
        // A run still open here was not ended where its queue ended: the
        // document was replaced under it. It is abandoned, saying nothing.
        const abandoned = header_run_ref.current;
        header_run_ref.current = null;
        if (abandoned?.replay !== undefined && pending_excel_header_ref.current !== null) {
            // A replay's request already posted is dropped with it. Its
            // answer can still arrive (a new document of the same file leaves
            // the request pending), and it would be reported as a gesture's,
            // about an Undo whose history is gone; until then the pending
            // request would keep every header control, transform request,
            // and view replay refused. With nothing pending the late answer
            // matches no request and is ignored.
            pending_excel_header_grid_focus_ref.current.delete(pending_excel_header_ref.current);
            pending_excel_header_ref.current = null;
            pending_excel_header_unhide_ref.current = false;
            pending_excel_header_promote_ref.current = false;
            set_pending_excel_header(null);
            set_excel_header_status('');
        }
        header_fence_ref.current = false;
        header_reload_required_ref.current = false;
        header_edit_warning_ref.current = null;
        set_header_fence(false);
        header_in_flight_ref.current = null;
        for (const timer of header_timer_refs.current) clearTimeout(timer);
        header_timer_refs.current = [];
        replace_excel_header_queue(null);
    }, [replace_excel_header_queue]);
    lower_header_fence_ref.current = lower_header_fence;

    /**
     * End the header queue's run, where the queue ends.
     *
     * A gesture's run records what the host says its requests changed, as one
     * step, however the queue ended: a header change that happened is never
     * left without a step. (So the sheets of an all-sheets gesture that
     * changed before a refusal are recorded.) With no editing session and
     * nothing marked unsaved, like any view step.
     *
     * A replay's run moves its entry when no request it posted failed, and
     * otherwise leaves the entry where it is and says why. History moves only
     * here, on the host's answer.
     *
     * For a result this runs before the snapshot that carried it is applied.
     * So a header entry is stamped with the body start from before its own
     * change (`HistoryEntry.bodyStarts`); nothing reads that field for a
     * view-only entry.
     *
     * A press made while the run was under way is held (a header change in
     * flight is the first thing a press is asked), and is carried out by the
     * drain after the render that follows the run's end. Until then the hold
     * covers what the fence covered: nothing new can be recorded. A replay
     * that did not move its entry drops that press, having said why.
     */
    const end_header_run = (failure?: { readonly reason: string }) => {
        const run = header_run_ref.current;
        if (run === null) return;
        header_run_ref.current = null;
        if (run.replay === undefined) {
            if (run.changes.length === 0) {
                // Nothing landed for the person's own gesture (rejected, its
                // worksheet or view gone, or the fold refused): a press held
                // behind it was for its step, and would otherwise undo the one
                // under it (as with Cancel). One that landed and changed
                // nothing is no failure, and the press runs.
                if (run.landed === 0 || (failure ?? run.failed) !== undefined) drop_press_behind_unrecorded_gesture();
                return;
            }
            const record = history_store_ref.current!.stage_record({
                label: header_step_label(run.changes),
                changes: run.changes.map((delta) => ({ kind: 'view' as const, delta })),
            });
            commit_staged_transaction([record]);
            return;
        }
        // A replay shows none of a gesture's status lines.
        set_excel_header_status('');
        const { direction, entry } = run.replay;
        const failed = failure ?? run.failed;
        if (failed !== undefined) {
            if ('reason' in failed) {
                refuse_history_press(view_replay_refusal_warning(direction, entry.action.label, failed.reason));
            } else if ('wait' in failed) {
                refuse_history_press(view_replay_wait_warning(failed.wait, direction));
            } else {
                // Said by what the queue already says (a result that needs a reload).
                refuse_history_press(null);
            }
            return;
        }
        land_view_replay(
            { ...run.replay, skipped: ordered_skips(run.skipped) },
            run.worksheet ?? entry.action.changes[0]!.delta.worksheet,
            run.landed === 0,
        );
    };
    /** End the run and the queue with it. */
    const finish_header_queue = (failure?: { readonly reason: string }) => {
        end_header_run(failure);
        lower_header_fence();
        wake_history_press();
    };

    const drain_excel_header_queue = () => {
        const queue = excel_header_queue_ref.current;
        if (queue === null || pending_excel_header_ref.current !== null) return;
        const [next_sheet] = queue.sheets;
        const run = header_run_ref.current;
        if (reopen_required_ref.current) {
            // Queued before this window said it no longer matches its file
            // (behind the replay it could not follow): not sent, and ended as
            // a result that needs a reload ends it. The window has just said
            // to reopen the file; the status line says the rest. A replay's
            // run would end the same way, its entry left where it is, but the
            // press gate refuses one before it is queued.
            //
            // A header result that needs a reload is never pending here: it
            // empties the queue, and nothing is queued under its fence, so
            // lowering the header fence here cannot clear it.
            if (run !== null) run.failed = { silent: true };
            set_excel_header_status('Header row was not updated.');
            finish_header_queue();
            return;
        }
        if (next_sheet === undefined) {
            finish_header_queue();
            return;
        }
        const current_sheets = meta_ref.current?.sheets ?? [];
        const next_sheet_index = excel_header_queue_sheet_index(current_sheets, next_sheet);
        if (next_sheet_index < 0) {
            // The worksheet left the workbook while the request waited.
            if (run?.replay !== undefined) run.skipped.add('sheets-gone');
            replace_excel_header_queue({ ...queue, sheets: queue.sheets.slice(1) });
            return;
        }
        if (queue.header_row !== undefined && generation_ref.current !== queue.generation) {
            // The display row it names belongs to a view that has since changed.
            set_excel_header_status('Header row was not updated.');
            finish_header_queue();
            return;
        }
        const now = Date.now();
        if (
            queue.retry_after_snapshot !== undefined
            && snapshot_applied_seq_ref.current <= queue.retry_after_snapshot
            && now < (queue.retry_not_before ?? 0)
        ) return;
        // Work admitted before the fence finishes into its stores first.
        if (
            save_in_flight_ref.current
            || save_projection_ref.current.operation !== undefined
            || (replay_coordinator_ref.current?.is_busy() ?? false)
            || pending_row_replay_busy_ref.current
            || pending_highlight_request_ref.current !== null
            || pending_row_resize_requests_ref.current.size > 0
            || pending_append_requests_ref.current.size > 0
            || discard_cleanup_ref.current !== undefined
            || view_request_is_pending()
        ) return;
        if (!queue.fenced) {
            // Keys typed while an appended row waited for admission open in
            // its cell once the grid has rendered the answer; let them land.
            if (editing_ref.current?.typing_pending() === true) {
                schedule_header_wake(HEADER_TYPING_WAKE_MS);
                return;
            }
            // Fold an open editor while gestures are still admitted, so its
            // text commits, then raise the fence.
            if (
                editing_session_held_ref.current
                && with_gesture_ticket(
                    queue.ticket,
                    () => editing_ref.current?.commit_live_edit(),
                ) === false
            ) {
                set_excel_header_status('Header row was not updated.');
                finish_header_queue();
                return;
            }
            header_fence_ref.current = true;
            set_header_fence(true);
            replace_excel_header_queue({ ...queue, fenced: true });
        }
        const session = csv_edit_session_id_ref.current;
        if (session !== undefined && editing_session_held_ref.current) {
            let current = excel_header_queue_ref.current!;
            if (!current.flushed) {
                publish_every_store_truth(session, false);
                current = { ...current, flushed: true, ack_wait_started: now };
                replace_excel_header_queue(current);
                schedule_header_wake(HEADER_ACK_WAIT_MS);
            }
            if (pending_changes_durability.has_unacknowledged(session)) {
                if (now - (current.ack_wait_started ?? now) >= HEADER_ACK_WAIT_MS) {
                    const reason = 'unsaved changes are still being stored. Try again.';
                    if (run?.replay === undefined) {
                        host_bridge.postMessage({
                            type: 'showWarning',
                            message: `Could not change the header row: ${reason}`,
                        });
                        set_excel_header_status('Header row was not updated.');
                    }
                    // A replay says it as its own refusal.
                    finish_header_queue({ reason });
                }
                return;
            }
        }
        const current = excel_header_queue_ref.current!;
        const grid_focus_sheet_index = current.grid_focus_sheet === undefined
            ? undefined
            : excel_header_queue_sheet_index(current_sheets, current.grid_focus_sheet);
        const result = request_excel_header(
            current.enabled,
            current.unhide_all,
            current.header_row,
            next_sheet_index,
            grid_focus_sheet_index === undefined || grid_focus_sheet_index < 0
                ? undefined
                : grid_focus_sheet_index,
            next_sheet.target,
        );
        if (result === 'wait') return;
        if (result === 'skip') {
            // The worksheet stopped offering a Header Row while it waited.
            if (run?.replay !== undefined) run.skipped.add('header-unavailable');
            replace_excel_header_queue({ ...current, sheets: current.sheets.slice(1) });
            return;
        }
        const posted_sheet = current_sheets[next_sheet_index]!;
        header_in_flight_ref.current = {
            queue: current,
            sheet: next_sheet,
            posted_snapshot: snapshot_applied_seq_ref.current,
            worksheet: {
                sheetIndex: next_sheet_index,
                sheetName: posted_sheet.name,
                ...(posted_sheet.worksheetId === undefined
                    ? {}
                    : { worksheetId: posted_sheet.worksheetId }),
            },
        };
        replace_excel_header_queue({ ...current, sheets: current.sheets.slice(1) });
        const posted = pending_excel_header_ref.current;
        header_timer_refs.current.push(setTimeout(() => {
            if (pending_excel_header_ref.current !== posted || posted === null) return;
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'The header row change has not finished. Reload this window to keep editing this file.',
            });
        }, HEADER_RESULT_GUARD_MS));
    };
    useEffect(() => {
        drain_excel_header_queue();
    });

    /**
     * What the queue does with a header result. A transient rejection (an
     * unacknowledged refresh, edit-session work finishing) goes back to the head
     * of the queue and is re-sent after the next applied snapshot or a short
     * wait; a result that needs a reload keeps the fence up; anything else ends
     * the request, and a refusal ends the whole queue.
     */
    header_result_handler_ref.current = (result, delivery) => {
        const in_flight = header_in_flight_ref.current;
        header_in_flight_ref.current = null;
        if (in_flight === null) return 'report';
        const run = header_run_ref.current;
        const replaying = run?.replay !== undefined;
        // A replay answers for itself: none of a gesture's status lines or
        // warnings are shown for it.
        const report = replaying ? 'handled' as const : 'report' as const;
        if (result.reloadRequired === true) {
            header_reload_required_ref.current = true;
            // The header change may have been stored, moving the Pending
            // Changes to the new header while this window's stores keep the
            // old numbering: none of them is sent until the reload replaces
            // them. (Everything was published and acknowledged before the
            // request was posted, so nothing is held back.)
            publication_fence.raise();
            // What changed before this is recorded; a replay's entry stays,
            // and the reload message below is what the person is told, in
            // place of anything an earlier sheet left to say.
            if (run !== null) run.failed = { silent: true };
            end_header_run();
            replace_excel_header_queue(null);
            set_excel_header_status('Reload this window to finish the header row change.');
            host_bridge.postMessage({
                type: 'showWarning',
                message: `Reload this window to keep editing this file.${
                    result.error ? ` ${result.error}` : ''}`,
            });
            return 'handled';
        }
        // A replay answered `recovered` with no change: the host cannot say
        // whether this request wrote anything. Asking again is right either
        // way. The same target, applied to the durable state as it now is,
        // changes nothing if the first write was in fact stored and does the
        // work if it was not, and the answer to that request says which.
        const unsettled_replay = replaying
            && result.outcome === 'recovered'
            && result.change === undefined;
        if (
            ((result.outcome === 'rejected' && result.transient === true) || unsettled_replay)
            && in_flight.queue.retries < HEADER_TRANSIENT_RETRIES
            && (in_flight.queue.header_row === undefined
                || generation_ref.current === in_flight.queue.generation)
        ) {
            const remaining = excel_header_queue_ref.current?.sheets ?? [];
            replace_excel_header_queue({
                ...in_flight.queue,
                sheets: [in_flight.sheet, ...remaining],
                retries: in_flight.queue.retries + 1,
                retry_after_snapshot: in_flight.posted_snapshot,
                retry_not_before: Date.now() + HEADER_RETRY_DELAY_MS,
            });
            schedule_header_wake(HEADER_RETRY_DELAY_MS);
            return 'retry';
        }
        if (result.outcome === 'rejected') {
            if (run !== null) {
                // The host's reason, also over an earlier sheet's "the file
                // was refreshing": trying again would meet this refusal.
                run.failed = { reason: result.error ?? 'The header row was not updated.' };
            }
            finish_header_queue();
            return report;
        }
        if (run !== null) {
            if (result.change !== undefined) {
                // The write was committed, and this is what it changed.
                run.landed += 1;
                const delta = header_view_delta(in_flight.worksheet, result.change);
                if (delta !== undefined) run.changes.push(delta);
            } else if (replaying) {
                // Still `recovered` with no change after the retries. The
                // queue goes on to its remaining sheets, as after any
                // `recovered`; the entry will stay.
                run.failed ??= { wait: 'refreshing' };
            }
        }
        if ((excel_header_queue_ref.current?.sheets.length ?? 0) === 0) finish_header_queue();
        return report;
    };

    /**
     * Ask for a Header Row change: check what the worksheet's Pending Changes
     * can't carry, then queue the request. The drain folds an open editor and
     * raises the header fence once earlier admitted work has finished.
     */
    const enqueue_excel_header_change = useCallback((request: HeaderQueueRequest): boolean => {
        if (
            excel_header_queue_ref.current !== null
            || pending_excel_header_ref.current !== null
            || header_fence_ref.current
        ) return false;
        const sheets = meta_ref.current?.sheets ?? [];
        const { replay } = request;
        // A replay is refused at the press gate before it gets here.
        if (replay === undefined && refused_for_reopen()) return false;
        // A header gesture made while a press of Undo or Redo is waiting is
        // not queued. Queued, it would be carried out ahead of the press, the
        // press would be held behind it, and the press would then undo the
        // header step: a gesture made after it. (One asked for before the
        // press is already in the queue, and finishes as it would have. Not
        // asked through `history_free`, which would also refuse a gesture
        // behind a replay or a write in flight, where it is queued.)
        if (replay === undefined && history_press_held()) {
            say_history_hold_gesture();
            return false;
        }
        const refusal = header_change_refusal(request.sheets);
        if (refusal !== undefined) {
            if (replay === undefined) {
                show_warning(`Could not change the header row: ${refusal}`);
            } else {
                refuse_history_press(view_replay_refusal_warning(
                    replay.direction,
                    replay.entry.action.label,
                    refusal,
                ));
            }
            return false;
        }
        const grid_focus_sheet = request.grid_focus_sheet_index === undefined
            ? undefined
            : sheets[request.grid_focus_sheet_index];
        header_run_ref.current = {
            ...(replay === undefined ? {} : { replay }),
            ...(request.worksheet === undefined ? {} : { worksheet: request.worksheet }),
            changes: [],
            landed: 0,
            skipped: new Set(replay?.skipped ?? []),
        };
        if (replay !== undefined) {
            // A replay raises the header fence at once: what the drain does
            // first for a gesture is already done (the open editor was folded
            // before the replay started, and it did not start while keys
            // were owed to a cell), and from this instant no edit may be
            // recorded and no cell opens.
            header_fence_ref.current = true;
            set_header_fence(true);
        }
        replace_excel_header_queue({
            enabled: request.enabled,
            unhide_all: request.unhide_all === true,
            ...(request.header_row === undefined ? {} : { header_row: request.header_row }),
            sheets: request.sheets.flatMap((sheet_index) => {
                const sheet = sheets[sheet_index];
                return sheet === undefined
                    ? []
                    : [excel_header_queue_sheet(sheet, request.targets?.get(sheet_index))];
            }),
            ...(grid_focus_sheet === undefined
                ? {}
                : { grid_focus_sheet: excel_header_queue_sheet(grid_focus_sheet) }),
            generation: generation_ref.current,
            retries: 0,
            fenced: replay !== undefined,
            flushed: false,
            ...(replay === undefined ? {} : { replay: replay.direction }),
            ticket: gesture_ticket(),
        });
        return true;
    }, [
        gesture_ticket,
        header_change_refusal,
        history_press_held,
        refuse_history_press,
        refused_for_reopen,
        replace_excel_header_queue,
        say_history_hold_gesture,
        show_warning,
    ]);
    enqueue_excel_header_change_ref.current = enqueue_excel_header_change;

    const handle_toggle_excel_header = useCallback(() => {
        const header = meta?.sheets[active_sheet_index]?.excelFirstRowHeader;
        if (!header) return;
        enqueue_excel_header_change({
            enabled: !(header.mode === 'on' || header.active),
            sheets: [active_sheet_index],
            grid_focus_sheet_index: active_sheet_index,
        });
    }, [active_sheet_index, enqueue_excel_header_change, meta]);

    /** Queue every sheet that is not already in `enabled`, for the chevron menu. */
    const set_excel_header_all_sheets = useCallback((enabled: boolean) => {
        if (header_waits_for_transform(active_sheet_index, false)) return;
        const sheets = (meta?.sheets ?? [])
            .map((sheet, index) => ({ sheet, index }))
            .filter(({ sheet }) => {
                const header = sheet.excelFirstRowHeader;
                if (!header) return false;
                return (header.mode === 'on' || header.active) !== enabled;
            })
            .map(({ index }) => index);
        if (sheets.length > 0) {
            enqueue_excel_header_change({
                enabled,
                sheets,
                grid_focus_sheet_index: active_sheet_index,
            });
        }
    }, [active_sheet_index, enqueue_excel_header_change, header_waits_for_transform, meta]);

    const handle_promote_row_to_header = useCallback((display_row: number) => {
        enqueue_excel_header_change({
            enabled: true,
            header_row: display_row,
            sheets: [active_sheet_index],
        });
    }, [active_sheet_index, enqueue_excel_header_change]);

    /**
     * The discard whose host-side cleanup has not been acknowledged yet.
     *
     * A discard is undoable, and the host refuses `requestEditSession` until its
     * cleanup settles — so undoing one awaits the acknowledgement rather than
     * asking into that window and being refused for a reason about timing.
     *
     * One shared promise per discard, not a list of waiters: the replay
     * coordinator admits a single outstanding replay, so a collection would model
     * a concurrency that cannot arise, and every additional awaiter can simply
     * await the same promise.
     */
    const discard_cleanup_ref = useRef<PendingSignal<boolean> & { readonly session: string }>();
    /** The same, for the next `editSessionResult` a replay is waiting on. */
    const session_grant_ref = useRef<PendingSignal<boolean>>();

    const settle_session_grant_waiters = useCallback((granted: boolean) => {
        const pending = session_grant_ref.current;
        if (pending === undefined) return;
        session_grant_ref.current = undefined;
        pending.settle(granted);
    }, []);

    /**
     * Hold an edit session, acquiring one if there is none, for a replay.
     *
     * Three waits, and the order is the point. A discard's host-side cleanup has
     * to settle first, because a request sent into that window is refused for a
     * reason about timing rather than about the document. Then a session is
     * requested if one is not already held. Only then does the replay build its
     * prepare request, because the grant crosses a hydration boundary that
     * replaces the stores wholesale.
     *
     * Acquiring is deliberate and one-directional: undo may bring unsaved work
     * back, and with it the session that holds it, and must never be what
     * releases one. The grant handler installs it as it does for a gesture.
     */
    const ensure_replay_session = useCallback(async (): Promise<boolean> => {
        const discarding = discard_cleanup_ref.current;
        if (discarding !== undefined) {
            // A clear that failed leaves editing disabled for the whole file, so
            // there is no session to be had and undo must not promise one.
            if (!await discarding.settled) return false;
        }
        // Held, not merely named: a session released a moment ago keeps its id
        // here until the host's next snapshot, and a replay prepared against
        // it would be refused for a session this panel no longer owns.
        if (editing_session_held_ref.current && csv_edit_session_id_ref.current !== undefined) return true;
        // A transform of this window still installing (a restore the window
        // posted after the press was let through, say): the host refuses a
        // session until it has, so the request waits for it instead of being
        // refused. A replaced document ends the wait, and the replay with it.
        // The last check and the request below are one synchronous step, so a
        // restore cannot be posted in between.
        const document = history_document_ref.current;
        const deadline = Date.now() + HISTORY_PRESS_HOLD_MS;
        let waited_discard = discarding;
        for (;;) {
            const wait = next_window_transform_wait(() => true, deadline, document);
            if (wait !== 'clear' && wait !== 'past-bound') {
                // Counted only while it waits for transforms: a Cancel of one
                // of them may go through then (`cancel_blocked`), and not
                // while it waits out a discard, when the host refuses one.
                replay_waiting_for_transforms_ref.current += 1;
                let next: 'again' | 'replaced';
                try {
                    next = await wait;
                } finally {
                    replay_waiting_for_transforms_ref.current -= 1;
                }
                if (next === 'replaced') return false;
                continue;
            }
            // A discard that started meanwhile is waited out too, and
            // the transforms are asked about again after it.
            const discarding_now = discard_cleanup_ref.current;
            if (discarding_now === undefined || discarding_now === waited_discard) break;
            if (!await discarding_now.settled) return false;
            waited_discard = discarding_now;
        }
        if (editing_session_held_ref.current && csv_edit_session_id_ref.current !== undefined) return true;
        // A request already in flight — an editing gesture made a moment ago —
        // is joined rather than duplicated: the host answers one request, and a
        // second would be refused while the first is outstanding.
        const already_requested = pending_edit_request_ref.current !== null;
        const grant = session_grant_ref.current ?? pending_signal<boolean>();
        session_grant_ref.current = grant;
        if (!already_requested) {
            set_edit_session_pending(true);
            const request_id = [
                'edit',
                edit_request_prefix_ref.current,
                ++edit_request_seq_ref.current,
            ].join(':');
            pending_edit_request_ref.current = request_id;
            // The sheet the discarded session was last editing, which is the
            // pointer the restored one should resume on. Not the active tab: the
            // grant's only use for the field is to set the initial pointer, and
            // the replay's own focus decides where the cursor lands.
            const sheet_index = edit_session_sheet_index_ref.current;
            const requested_sheet = meta_ref.current?.sheets[sheet_index];
            host_bridge.postMessage({
                type: 'requestEditSession',
                requestId: request_id,
                sheetIndex: sheet_index,
                sheetName: requested_sheet?.name,
                worksheetId: requested_sheet?.worksheetId,
            });
        }
        return grant.settled;
    }, [next_window_transform_wait]);
    // In an effect, not the render body: a render-phase write is a side effect,
    // and StrictMode's double render makes that a rule with teeth. A layout effect
    // is early enough — nothing calls this before the user asks for a replay.
    useLayoutEffect(() => {
        ensure_replay_session_ref.current = ensure_replay_session;
    }, [ensure_replay_session]);

    /**
     * Acquire the workbook's editing session for an editing gesture.
     *
     * There is no edit mode to enter: a file that can be edited accepts the
     * gesture as it is, and the session the host needs behind it is acquired
     * here, on the way. GridShell holds the gesture until this settles and then
     * runs it, or drops it when the host refuses.
     *
     * `quiet` is for a request the user did not make as an edit, such as opening
     * a menu that would offer editing items: a refusal the renderer can predict
     * is then not announced. The host's own refusals speak for themselves.
     *
     * Joins a request already in flight, as `ensure_replay_session` does, and
     * waits out a discard's cleanup for the same reason it does.
     */
    const request_edit_session = useCallback(async (quiet = false): Promise<boolean> => {
        const held = () => editing_session_held_ref.current
            && csv_edit_session_id_ref.current !== undefined;
        if (held()) return true;
        const discarding = discard_cleanup_ref.current;
        if (discarding !== undefined && !await discarding.settled) return false;
        if (held()) return true;
        // A restore of the saved view this window posted (after a Save, say)
        // is waited for: the person did not ask for it, and an edit refused
        // for it would read as a sort of theirs in the way. Not for a quiet
        // request (a menu opening), which is refused quietly as before, nor
        // for one that joins a request already out.
        if (!quiet && pending_edit_request_ref.current === null) {
            const document = history_document_ref.current;
            const generation = generation_ref.current;
            const visit = sheet_visit_ref.current;
            const grid = grid_instance_ref.current;
            // The sheet the gesture is on, by identity: a snapshot that puts
            // another worksheet at its index replaces the grid too.
            const sheet_index = active_sheet_index_for_focus_ref.current;
            const sheet_identity = () => {
                const sheet = meta_ref.current?.sheets[sheet_index];
                return sheet?.worksheetId ?? sheet?.name;
            };
            const identity = sheet_identity();
            const deadline = Date.now() + HISTORY_PRESS_HOLD_MS;
            const restoring = (sheet_index: number) => pending_transform_origins_ref.current[sheet_index] === 'restore';
            for (;;) {
                const wait = next_window_transform_wait(restoring, deadline, document);
                if (wait === 'clear' || wait === 'past-bound') break;
                if (await wait === 'replaced') return false;
                // The person went to another sheet (even if they came back):
                // the grid that held the gesture is gone, and the gesture with
                // it. Nothing is said; they left it. Asked first, so a view that
                // also moved meanwhile does not speak for a gesture left behind.
                if (sheet_visit_ref.current !== visit || sheet_identity() !== identity) return false;
                // The view moved under it: said below.
                if (generation_ref.current !== generation) break;
                // Another grid on the same sheet (the document loaded again):
                // the gesture's keys went with the old one, and again nothing
                // is said.
                if (grid_instance_ref.current !== grid) return false;
                if (held()) return true;
            }
            // A restore that moved the view remounted the grid that holds the
            // gesture's keys: nothing is left to open an editor for, so the
            // edit is refused with a reason, as it was before it could wait.
            // That is most restores (one computed afresh after a refresh moves
            // the generation); only one the host acknowledges as already in
            // place lets the edit through. A refresh can move it too, so the
            // reason names the view, not a sort.
            if (generation_ref.current !== generation) {
                host_bridge.postMessage({
                    type: 'showWarning',
                    message: 'The table view changed before the edit could start. Try again.',
                });
                return false;
            }
        }
        if (held()) return true;
        if (pending_edit_request_ref.current === null) {
            // Only work in flight, and only because the host refuses it: warning
            // locally saves a round-trip whose answer is already known. An
            // *installed* sort, filter, or hidden-row rule is no reason to
            // refuse, because editing under one moves no rows.
            if (pending_transform_request_ids_ref.current[active_sheet_index_for_focus_ref.current]) {
                if (!quiet) {
                    host_bridge.postMessage({
                        type: 'showWarning',
                        message: 'Wait for sorting and filtering to finish before editing.',
                    });
                }
                return false;
            }
            set_edit_session_pending(true);
            const request_id = [
                'edit',
                edit_request_prefix_ref.current,
                ++edit_request_seq_ref.current,
            ].join(':');
            pending_edit_request_ref.current = request_id;
            const sheet_index = active_sheet_index_for_focus_ref.current;
            const requested_sheet = meta_ref.current?.sheets[sheet_index];
            host_bridge.postMessage({
                type: 'requestEditSession',
                requestId: request_id,
                // The sheet the gesture was made on. It becomes the initial
                // renderer pointer for this one shared grant.
                sheetIndex: sheet_index,
                sheetName: requested_sheet?.name,
                worksheetId: requested_sheet?.worksheetId,
                ...(quiet ? { quiet: true } : {}),
            });
        }
        const grant = session_grant_ref.current ?? pending_signal<boolean>();
        session_grant_ref.current = grant;
        return grant.settled;
    }, [next_window_transform_wait]);

    /**
     * Release a session that holds nothing: no unsaved change on any worksheet,
     * no open editor, and nothing in flight that would add one.
     *
     * A session exists to carry unsaved work. Held past that it would keep the
     * rows frozen, the header row locked, and every other panel on this file
     * read-only, for no edit anyone made. So it goes as soon as it is empty,
     * and the next editing gesture acquires another.
     *
     * Conservative by construction: every term is a reason to keep the session,
     * and a grid that cannot answer for itself is one.
     */
    const release_edit_session_if_idle = useCallback(() => {
        const editing = editing_ref.current;
        if (
            !editing_session_held_ref.current
            || csv_edit_session_id_ref.current === undefined
            || editing === null
            || editing.session_busy()
            || save_in_flight_ref.current
            || save_projection_ref.current.operation !== undefined
            || pending_edit_request_ref.current !== null
            || discard_cleanup_ref.current !== undefined
            || pending_saved_row_restorations_ref.current.size > 0
            || !edit_gestures_admitted({ ignore_reopen: true })
            // Text typed into the append composer is unsaved work too, and the
            // drafts are dropped with the session that owns them.
            || [...append_composer_drafts_ref.current.values()].some(({ draft }) =>
                draft.some((row) => Object.values(row).some((value) => value !== '')))
            || edit_session_registry_ref.current!.has_dirty_entries()
        ) return;
        end_editing_session();
    }, [edit_gestures_admitted, end_editing_session]);
    // After every render, because the facts above change through a dozen
    // handlers and none of them should have to remember this. GridShell asks
    // again when something only it can see has ended, such as an editor closed
    // without a change.
    useEffect(() => {
        release_edit_session_if_idle();
    });

    /**
     * The one place that decides whether this webview will ask the host for a
     * transform at all. Its own function because four call sites need the same
     * answer and drifted once already: Cancel checked only the save, and a cancel is
     * itself a transform request.
     *
     * The editing session is deliberately not here: the host admits a transform from the panel
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
        // `history_free`, not `edit_gestures_admitted`: a person's second
        // sort may replace their first while it is still in flight.
        || !history_free()
    ), [edit_session_pending, history_free, preview_mode]);

    /**
     * Cancel's own gate: the same windows, on the terms that held before view
     * requests were counted. A cancel has to stay reachable while a view
     * step's replay is in flight, since cancelling is how a slow one is
     * abandoned; `request_transform` then drops the replay's record and its
     * entry stays where it was.
     */
    const cancel_blocked = useCallback((): boolean => (
        save_in_flight_ref.current
        || edit_session_pending
        || preview_mode
        || pending_excel_header_ref.current !== null
        // A replay still waiting for this window's transforms has asked the
        // host for nothing yet: a Cancel of one of them goes through, and the
        // replay waits for the cancel's answer instead.
        || !base_gestures_admitted({ replay_waiting_may_pass: true })
    ), [base_gestures_admitted, edit_session_pending, preview_mode]);

    /**
     * Whether a view gesture may start now, having folded the open editor.
     *
     * One gesture at a time, across kinds and sheets: the host does not
     * serialize a transform's computation with a column write or with a
     * transform on another sheet, so two in flight could land, and be
     * recorded, in the other order. A transform on the same sheet may still
     * replace the one pending there.
     *
     * Every check runs after the fold, on the state the fold left. If the
     * window is busy only then, the edit is committed and the person is told
     * to repeat the gesture, instead of a click that silently did nothing.
     *
     * `transform_sheet_index` is the sheet a sort, filter, or hide is for;
     * undefined for a column gesture.
     */
    const view_gesture_may_start = useCallback((
        transform_sheet_index: number | undefined,
    ): boolean => {
        if (refused_for_reopen()) return false;
        const fold = fold_before_view_request();
        if (fold === 'refused') return false;
        const column_write = pending_column_write_ref.current;
        const width_write = pending_width_write_ref.current;
        if (
            (column_write !== null && column_write.replay === undefined)
            || (width_write !== null && width_write.replay === undefined)
            || [...pending_row_resize_requests_ref.current.values()].some((pending) => pending.gesture)
            || pending_view_transforms_ref.current.some((pending, index) => (
                pending !== undefined
                && pending.replay === undefined
                && index !== transform_sheet_index
            ))
            // One view action per window (I1), from its first choice until the
            // host has settled it, which outlasts its pending record.
            || (view_action_ref.current !== undefined
                && view_action_ref.current.action.sheetIndex !== transform_sheet_index)
        ) {
            show_warning(VIEW_GESTURE_WAIT_MESSAGE);
            return false;
        }
        // A column gesture, like a size gesture, does not start during a save:
        // a structural save renumbers the columns its step would name.
        const blocked = transform_sheet_index === undefined
            ? save_in_flight_ref.current || !edit_gestures_admitted()
            : transform_request_blocked();
        // With nothing folded this refusal is silent, as it always was (a
        // click behind a save or a replay in flight). After a fold it is not:
        // the click did commit the edit, and only the gesture is left to repeat.
        if (blocked && fold === 'folded') show_warning(VIEW_GESTURE_WAIT_MESSAGE);
        return !blocked;
    }, [edit_gestures_admitted, fold_before_view_request, refused_for_reopen, show_warning, transform_request_blocked]);

    /**
     * While a worksheet holds Pending Inserted Rows its display order must
     * stay the layout's, so a request that would sort, filter, or hide rows
     * on it is refused with the reason. One clearing a transform is not
     * refused: none can exist while inserted rows do, and clearing is harmless.
     */
    const inserted_rows_refuse_transform = useCallback((sheet_index: number): boolean => {
        for (const [index, store] of edit_session_registry_ref.current?.pending_entries() ?? []) {
            if (index !== sheet_index || !has_inserted_or_moved_rows(store.snapshot())) continue;
            host_bridge.postMessage({ type: 'showWarning', message: INSERTED_ROWS_TRANSFORM_MESSAGE });
            return true;
        }
        return false;
    }, []);

    const handle_transform_change = useCallback(
        (next_state: SheetTransformState, origin: TransformOrigin): boolean => {
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
            // A request that changes nothing is not a gesture: it folds no
            // open editor and says nothing.
            if (transforms_semantically_equal(current, sanitized)) return false;
            // A new choice drops a press waiting behind the view action, silently,
            // as Cancel does: the press was made for a stack the choice changes,
            // and would otherwise hold the choice off (I5).
            if (
                view_action_ref.current?.action.sheetIndex === active_sheet_index
                && held_press_ref.current !== null
                && held_press_ref.current.typing !== true
            ) {
                drop_history_presses({ keep_typing: true });
            }
            // A hide, a replay, or a restore in flight on the sheet holds the
            // choice: replacing its request would leave its answer unmatched.
            if (view_choice_waits(active_sheet_index)) {
                show_warning(VIEW_GESTURE_WAIT_MESSAGE);
                return false;
            }
            if (!view_gesture_may_start(active_sheet_index)) return false;
            if (
                (sanitized.sort.length > 0
                    || sanitized.filters.some((filter) => filter.enabled)
                    || (sanitized.hiddenRows?.length ?? 0) > 0)
                && inserted_rows_refuse_transform(active_sheet_index)
            ) return false;
            if (active_sheet === undefined || schema === undefined) {
                request_transform(active_sheet_index, sanitized, 'user', origin);
                return true;
            }
            const worksheet: WorksheetTarget = {
                sheetIndex: active_sheet_index,
                sheetName: active_sheet.name,
                ...(active_sheet.worksheetId === undefined
                    ? {}
                    : { worksheetId: active_sheet.worksheetId }),
            };
            // The choice joins the sheet's action, or begins one from the rules
            // this window last saw installed (I4). The action records one step,
            // from that baseline, when the host has settled all it sent.
            const pending_action = view_action_ref.current?.action.sheetIndex === active_sheet_index
                ? view_action_ref.current
                : undefined;
            const action = pending_action?.action ?? begin_view_action(
                active_sheet_index,
                schema,
                state_ref.current.transforms?.[active_sheet_index],
            );
            const request_id = request_transform(
                active_sheet_index,
                sanitized,
                'user',
                origin,
                {
                    worksheet,
                    schema,
                    baseline: action.baseline,
                    target: sanitized,
                },
            );
            view_action_ref.current = {
                action: choose_in_view_action(action, sanitized, request_id),
                worksheet: pending_action?.worksheet ?? worksheet,
                schema: pending_action?.schema ?? schema,
                initialBaseline: pending_action?.initialBaseline ?? action.baseline,
                refused: false,
            };
            sync_view_request_pending();
            publish_history_menu_ref.current();
            return true;
        },
        [
            active_sheet_index,
            drop_history_presses,
            inserted_rows_refuse_transform,
            meta,
            request_transform,
            sync_view_request_pending,
            view_gesture_may_start,
        ],
    );

    const handle_hide_rows = useCallback((display_rows: DisplayRowInterval[]) => {
        if (
            !view_gesture_may_start(active_sheet_index)
            || pending_transforms[active_sheet_index]
            || inserted_rows_refuse_transform(active_sheet_index)
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
        // No target: this window sends display rows and learns the source rows
        // it hid only from the install.
        const hidden_sheet = meta_ref.current?.sheets[active_sheet_index];
        pending_view_transforms_ref.current[active_sheet_index] = hidden_sheet === undefined
            ? undefined
            : {
                requestId: request_id,
                worksheet: {
                    sheetIndex: active_sheet_index,
                    sheetName: hidden_sheet.name,
                    ...(hidden_sheet.worksheetId === undefined
                        ? {}
                        : { worksheetId: hidden_sheet.worksheetId }),
                },
                schema: transform_schema_for_sheet(hidden_sheet),
                baseline: state_ref.current.transforms?.[active_sheet_index],
            };
        sync_view_request_pending();
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
        inserted_rows_refuse_transform,
        pending_transforms,
        sync_view_request_pending,
        view_gesture_may_start,
    ]);

    const request_append_rows = useCallback((count: number): Promise<
        AppendRowsAdmission | undefined
    > => {
        const edit_session_id = csv_edit_session_id_ref.current;
        const sheet = meta_ref.current?.sheets[active_sheet_index];
        if (
            edit_session_id === undefined
            || sheet === undefined
            || !Number.isSafeInteger(count)
            || count <= 0
        ) return Promise.resolve(undefined);
        // Rows asked for while a press of Undo or Redo is waiting are not
        // added: the press would then remove rows added after it. Rows asked
        // for before the press carry their ticket to this check.
        if (!press_admits()) {
            say_history_hold_gesture();
            return Promise.resolve(undefined);
        }
        const source_generation = source_generation_ref.current;
        const request_id = [
            'append',
            append_request_prefix_ref.current,
            ++append_request_seq_ref.current,
        ].join(':');
        return new Promise((resolve) => {
            pending_append_requests_ref.current.set(request_id, {
                kind: 'append',
                sourceGeneration: source_generation,
                editSessionId: edit_session_id,
                sheetIndex: active_sheet_index,
                resolve,
            });
            set_append_request_pending(true);
            host_bridge.postMessage({
                type: 'requestAppendRows',
                requestId: request_id,
                editSessionId: edit_session_id,
                worksheet: {
                    sheetIndex: active_sheet_index,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet.worksheetId }),
                },
                sourceGeneration: source_generation,
                count,
            });
        });
    }, [active_sheet_index]);

    const request_structural_insert = useCallback((request: StructuralInsertRequest): Promise<
        StructuralInsertAdmission | undefined
    > => {
        const edit_session_id = csv_edit_session_id_ref.current;
        const sheet = meta_ref.current?.sheets[active_sheet_index];
        if (
            edit_session_id === undefined
            || sheet === undefined
            || !Number.isSafeInteger(request.count)
            || request.count <= 0
        ) return Promise.resolve(undefined);
        // A sort, filter, or hide still computing would commit after the
        // insert, under the inserted-rows lock: the host refuses the overlap
        // too, and this keeps the request from being sent at all.
        if (pending_transform_request_ids_ref.current[active_sheet_index] !== undefined) {
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'Wait for sorting and filtering to finish, then insert again.',
            });
            return Promise.resolve(undefined);
        }
        const source_generation = source_generation_ref.current;
        const request_id = [
            'insert',
            append_request_prefix_ref.current,
            ++append_request_seq_ref.current,
        ].join(':');
        return new Promise((resolve) => {
            pending_append_requests_ref.current.set(request_id, {
                kind: 'insert',
                sourceGeneration: source_generation,
                editSessionId: edit_session_id,
                sheetIndex: active_sheet_index,
                resolve,
            });
            set_append_request_pending(true);
            host_bridge.postMessage({
                type: 'requestStructuralInsert',
                requestId: request_id,
                editSessionId: edit_session_id,
                worksheet: {
                    sheetIndex: active_sheet_index,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet.worksheetId }),
                },
                sourceGeneration: source_generation,
                axis: 'rows',
                anchor: { row: request.anchor },
                side: request.side,
                count: request.count,
            });
        });
    }, [active_sheet_index]);

    /**
     * Ask the host to admit a column insert. It shares the in-flight map with
     * appends and row inserts, as the host's one reservation slot does, so
     * every fence that waits for an append waits for it too.
     */
    const request_structural_column_insert = useCallback((request: StructuralColumnInsertRequest): Promise<
        StructuralColumnInsertAdmission | undefined
    > => {
        const edit_session_id = csv_edit_session_id_ref.current;
        const sheet = meta_ref.current?.sheets[active_sheet_index];
        if (
            edit_session_id === undefined
            || sheet === undefined
            || !Number.isSafeInteger(request.count)
            || request.count <= 0
        ) return Promise.resolve(undefined);
        const source_generation = source_generation_ref.current;
        const request_id = [
            'insert-columns',
            append_request_prefix_ref.current,
            ++append_request_seq_ref.current,
        ].join(':');
        return new Promise((resolve) => {
            pending_append_requests_ref.current.set(request_id, {
                kind: 'insertColumns',
                sourceGeneration: source_generation,
                editSessionId: edit_session_id,
                sheetIndex: active_sheet_index,
                resolve,
            });
            set_append_request_pending(true);
            host_bridge.postMessage({
                type: 'requestStructuralInsert',
                requestId: request_id,
                editSessionId: edit_session_id,
                worksheet: {
                    sheetIndex: active_sheet_index,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet.worksheetId }),
                },
                sourceGeneration: source_generation,
                axis: 'columns',
                anchor: { column: request.anchor },
                side: request.side,
                count: request.count,
            });
        });
    }, [active_sheet_index]);

    const handle_unhide_all_rows = useCallback(() => {
        const header = meta?.sheets[active_sheet_index]?.excelFirstRowHeader;
        if (header?.mode === 'on' && header.sourceRow !== 0) {
            // Turns the promoted header off as it restores the rows above it,
            // so it moves the body start like any Header Row change.
            enqueue_excel_header_change({
                enabled: false,
                unhide_all: true,
                sheets: [active_sheet_index],
            });
            return;
        }
        // Composed onto the rules asked for, so a sort or filter in flight is kept (I6).
        const current = pending_transform_states_ref.current[active_sheet_index]
            ?? state_ref.current.transforms?.[active_sheet_index]
            ?? transforms[active_sheet_index]
            ?? EMPTY_TRANSFORM;
        const { hiddenRows: _hidden_rows, ...next } = current;
        handle_transform_change(next, 'toolbar');
    }, [
        active_sheet_index,
        enqueue_excel_header_change,
        handle_transform_change,
        meta,
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

    const handle_cancel_compare = useCallback(() => {
        host_bridge.postMessage({ type: 'cancelCompare' });
    }, []);

    /**
     * Compare mode's changed-rows filter. Expressed as a transform so it
     * composes with sorting and column filters instead of being a second,
     * parallel notion of "which rows are shown" — which is also why the button
     * reads its state back off the installed transform rather than keeping its
     * own copy: a refusal, a rollback, or a sheet switch would desync a copy.
     */
    const handle_toggle_only_changed_rows = useCallback(
        (next: boolean) => {
            // Read from the same refs handle_transform_change validates against,
            // so the toggle rides whatever sort and filters are current rather
            // than a render-time copy that may be a beat behind.
            const current = pending_transform_states_ref.current[active_sheet_index]
                ?? state_ref.current.transforms?.[active_sheet_index]
                ?? EMPTY_TRANSFORM;
            handle_transform_change({ ...current, onlyChangedRows: next }, 'toolbar');
        },
        [handle_transform_change, active_sheet_index],
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
            !view_gesture_may_start(active_sheet_index)
            || view_choice_waits(active_sheet_index)
            || inserted_rows_refuse_transform(active_sheet_index)
        ) return;
        set_filter_editor({ column_index, anchor, restore_focus, origin });
    }, [
        active_sheet_index,
        inserted_rows_refuse_transform,
        view_gesture_may_start,
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
        const opened_from_grid = filter_editor?.origin === 'grid';
        set_filter_editor(null);
        if (filter_restore_timer_ref.current !== undefined) {
            window.clearTimeout(filter_restore_timer_ref.current);
        }
        if (restore_focus) {
            filter_restore_timer_ref.current = window.setTimeout(() => {
                filter_restore_timer_ref.current = undefined;
                restore?.();
                // The editor can outlive what opened it: a reload that keeps
                // the columns remounts the grid, and another window can remove
                // the filter whose chip opened it. The opener's callback then
                // reaches nothing, and focus goes to the grid mounted now, or
                // to the toolbar when there is no grid to take it (every
                // column hidden). Only when nothing holds focus: the person
                // may already have moved it.
                if (
                    !has_surviving_focus_target()
                    && document.hasFocus()
                    && !(opened_from_grid && grid_focus_ref.current?.focus() === true)
                ) toolbar_focus_ref.current?.focus();
            }, 0);
        } else {
            filter_restore_timer_ref.current = undefined;
        }
    }, [filter_editor]);

    // A refresh closed the editor (its column can now mean another one), and
    // nobody dismissed it, so nobody handed focus back. The same hand-back as
    // a dismissal's, by the tokens a refresh uses: such a refresh remounts
    // the grid, which cannot take focus until it is mounted. To the grid, or
    // to the toolbar when the grid has nothing to focus or a chip opened the
    // editor; never from a control the person moved to. What opened the
    // editor is not asked: the columns it belonged to changed under it.
    useEffect(() => {
        const origin = filter_editor_closed_by_refresh_ref.current;
        if (origin === null) return;
        filter_editor_closed_by_refresh_ref.current = null;
        if (filter_editor !== null) return;
        if (origin === 'grid') {
            set_grid_focus_restore((current) => current ?? {
                sheet_index: active_sheet_index,
                generation: generation_ref.current,
                document_epoch: document_epoch_ref.current,
                or_toolbar: true,
            });
        } else {
            set_toolbar_focus_restore((current) => current ?? {
                sheet_index: active_sheet_index,
                document_epoch: document_epoch_ref.current,
            });
        }
    }, [active_sheet_index, filter_editor, set_grid_focus_restore]);

    const apply_filter_editor = useCallback((entry: FilterEntry) => {
        if (!filter_editor) return;
        // During a restore the editor stays open with its draft: the choice
        // would otherwise be composed onto rules the restore is still asking for.
        if (pending_transform_origins_ref.current[active_sheet_index] === 'restore') {
            show_warning(VIEW_GESTURE_WAIT_MESSAGE);
            return;
        }
        // Composed onto the rules asked for, so a choice in flight is kept (I6).
        const current = pending_transform_states_ref.current[active_sheet_index]
            ?? transforms[active_sheet_index]
            ?? EMPTY_TRANSFORM;
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
        show_warning,
        transforms,
    ]);

    const remove_filter_editor = useCallback(() => {
        if (!filter_editor) return;
        if (pending_transform_origins_ref.current[active_sheet_index] === 'restore') {
            show_warning(VIEW_GESTURE_WAIT_MESSAGE);
            return;
        }
        const current = pending_transform_states_ref.current[active_sheet_index]
            ?? transforms[active_sheet_index]
            ?? EMPTY_TRANSFORM;
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
        show_warning,
        transforms,
    ]);

    /**
     * Cancel the view action on a sheet, back to its baseline (I4): the rules
     * installed when its first choice was made, with the compare toggle kept as
     * asked. The cancel is the action's newest request, so the action ends when
     * the host settles it, with no step if the baseline is what is installed
     * then. Presses waiting behind the action are dropped silently, as Cancel
     * drops them. Answers whether there was an action to cancel.
     */
    const cancel_view_action_on_sheet = useCallback((sheet_index: number): boolean => {
        const pending = view_action_ref.current;
        if (pending === undefined || pending.action.sheetIndex !== sheet_index) return false;
        if (pending.action.cancelled) return true;
        drop_history_presses({ keep_typing: true });
        const cancelled = cancel_view_action(pending.action, '');
        const request_id = request_transform(sheet_index, cancelled.requested, 'cancel');
        view_action_ref.current = {
            ...pending,
            action: cancel_view_action(pending.action, request_id),
            refused: false,
        };
        publish_history_menu_ref.current();
        return true;
    }, [drop_history_presses, request_transform]);

    cancel_view_action_ref.current = cancel_view_action_on_sheet;
    cancel_blocked_ref.current = cancel_blocked;

    const handle_cancel_transform = useCallback(() => {
        // A cancel the host would refuse must not displace the request it is
        // cancelling: request_transform overwrites the pending requestId, so the
        // original in-flight response would stop matching and the webview would sit
        // on a stale generation. That is why a cancel asks the same question every
        // other transform request asks — see `transform_request_blocked` — on
        // the terms `cancel_blocked` keeps. A window that must be reopened
        // cancels nothing either: were a sort on its way when it said so, it
        // would land and stay until the reopen.
        if (refused_for_reopen()) return;
        if (cancel_blocked()) return;
        if (cancel_view_action_on_sheet(active_sheet_index)) return;
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
        // A press of Undo or Redo waiting behind what is cancelled is dropped
        // with it, and nothing is said. The cancel replaces the pending
        // record with no answer to anyone, so nothing else would end that
        // press, and it would then run against a stack it was not made for:
        // an Undo held behind a slow Undo would start the same undo the
        // person has just stopped; a Redo held behind it would redo an older
        // entry; an Undo held behind the person's own sort would undo the
        // step under a sort that was never recorded. Cancel is the person's
        // own instruction to stop, made after the press.
        drop_history_presses({ keep_typing: true });
        request_transform(active_sheet_index, previous, 'cancel');
    }, [
        active_sheet_index,
        cancel_blocked,
        cancel_view_action_on_sheet,
        drop_history_presses,
        meta,
        refused_for_reopen,
        request_transform,
        sheet_views,
    ]);

    const request_save_or_remain_dirty = useCallback(() => {
        // See `begin_save_operation`: nothing is saved from a window that must
        // be reopened, or across a header change.
        if (reopen_required_ref.current) {
            say_history(REOPEN_REQUIRED_SAVE_MESSAGE);
            return true;
        }
        const editing = editing_ref.current;
        if (!editing) return false;
        if (header_fence_ref.current) {
            warn_save_waits_for_header();
            return true;
        }
        // request_save() has side effects, so it is evaluated first. If workbook
        // preflight blocks, the active sheet may be clean while a sibling store is
        // still dirty; keep the session open from the registry-wide truth.
        const requested = editing.request_save();
        return requested
            || edit_session_registry_ref.current!.has_dirty_entries();
    }, [say_history, warn_save_waits_for_header]);

    const handle_save = useCallback(() => {
        request_save_or_remain_dirty();
    }, [request_save_or_remain_dirty]);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;
            if (msg.type === 'compareProgress') {
                set_compare_progress({
                    scannedRows: msg.scannedRows,
                    totalRows: msg.totalRows,
                });
            }
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
            if (msg.type === 'lfsResolveEnded') {
                // Matched, not merely received: a stale ending — a duplicate
                // request's, or one from before a reload — must not clear a
                // resolve that is still running.
                if (pending_lfs_resolve_request_ref.current !== msg.requestId) return;
                pending_lfs_resolve_request_ref.current = null;
                set_lfs_resolving(false);
            }
            if (msg.type === 'editSessionResult') {
                if (pending_edit_request_ref.current !== msg.requestId) return;
                pending_edit_request_ref.current = null;
                set_edit_session_pending(false);
                set_restore_wake((wake) => wake + 1);
                if (msg.granted && msg.editSessionId) {
                    if (!diff_mode_initialized_ref.current) {
                        set_diff_mode(msg.diffOnByDefault ?? diff_on_by_default_ref.current);
                        diff_mode_initialized_ref.current = true;
                    }
                    if (
                        editing_session_held_ref.current
                        && csv_edit_session_id_ref.current !== msg.editSessionId
                    ) {
                        advance_edit_activation();
                    }
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
                    // would also reset column visibility, and a session grant is
                    // not a data reload.
                    install_edit_session(
                        msg.pendingChanges?.cells ?? msg.pendingEdits,
                        msg.editSessionId,
                        msg.sheetIndex ?? 0,
                        msg.pendingChanges,
                    );
                    set_editing_session_held(true);
                } else if (csv_edit_session_id_ref.current === undefined) {
                    set_csv_edit_session_id(undefined);
                    set_editing_session_held(false);
                }
                // After the install and the edit-mode transition, so a replay
                // resuming here reads the stores the grant just replaced rather
                // than the ones it is about to.
                settle_session_grant_waiters(msg.granted && !!msg.editSessionId);
            } else if (msg.type === 'structuralInsertResult'
                && pending_append_requests_ref.current.get(msg.requestId)?.kind === 'insertColumns') {
                const pending = pending_append_requests_ref.current.get(msg.requestId)!;
                if (pending.kind !== 'insertColumns') return;
                pending_append_requests_ref.current.delete(msg.requestId);
                if (pending_append_requests_ref.current.size === 0) {
                    set_append_request_pending(false);
                }
                if (
                    msg.sourceGeneration !== pending.sourceGeneration
                    || msg.sourceGeneration !== source_generation_ref.current
                    || csv_edit_session_id_ref.current !== pending.editSessionId
                    || rendered_sheet_index_ref.current !== pending.sheetIndex
                    || !msg.granted
                    || msg.columnIds === undefined
                    || msg.structuralBasis === undefined
                ) {
                    if (msg.granted) {
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: pending.editSessionId,
                            accepted: false,
                        });
                    }
                    pending.resolve(undefined);
                    // The person's own gesture was refused, so nothing was recorded: a press
                    // held behind it was for its step, and would otherwise undo the one under it
                    // (as with Cancel).
                    drop_press_behind_unrecorded_gesture();
                    wake_history_press();
                    if (msg.reason) {
                        host_bridge.postMessage({ type: 'showWarning', message: msg.reason });
                    }
                    return;
                }
                let settled = false;
                // The document the admission was granted in: a refusal to
                // install it, if a replacement came first, is not about a press
                // made in the new one.
                const admitted_document = history_document_ref.current;
                // In flight for a press until the grid has installed it, or not.
                unsettled_admissions_ref.current.add(msg.requestId);
                pending.resolve({
                    columnIds: msg.columnIds,
                    structuralBasis: msg.structuralBasis,
                    settle: (accepted) => {
                        if (settled) return;
                        settled = true;
                        unsettled_admissions_ref.current.delete(msg.requestId);
                        // The grid did not install what was admitted: the
                        // person's own gesture recorded nothing, and a press
                        // held behind it was for its step.
                        if (!accepted && history_document_ref.current === admitted_document) {
                            drop_press_behind_unrecorded_gesture();
                        }
                        wake_history_press();
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: pending.editSessionId,
                            accepted,
                        });
                    },
                });
            } else if (msg.type === 'structuralInsertResult') {
                const pending = pending_append_requests_ref.current.get(msg.requestId);
                if (pending === undefined || pending.kind !== 'insert') {
                    // A reply to a request this window no longer tracks (it
                    // remounted, or the document left) is settled as released.
                    if (msg.granted && csv_edit_session_id_ref.current !== undefined) {
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: csv_edit_session_id_ref.current,
                            accepted: false,
                        });
                    }
                    return;
                }
                pending_append_requests_ref.current.delete(msg.requestId);
                if (pending_append_requests_ref.current.size === 0) {
                    set_append_request_pending(false);
                }
                if (
                    msg.sourceGeneration !== pending.sourceGeneration
                    || msg.sourceGeneration !== source_generation_ref.current
                    || csv_edit_session_id_ref.current !== pending.editSessionId
                    || rendered_sheet_index_ref.current !== pending.sheetIndex
                    || !msg.granted
                    || msg.rowIds === undefined
                    || msg.formatTemplate === undefined
                    || msg.structuralBasis === undefined
                    || msg.appendBasis === undefined
                ) {
                    if (msg.granted) {
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: pending.editSessionId,
                            accepted: false,
                        });
                    }
                    pending.resolve(undefined);
                    // The person's own gesture was refused, so nothing was recorded: a press
                    // held behind it was for its step, and would otherwise undo the one under it
                    // (as with Cancel).
                    drop_press_behind_unrecorded_gesture();
                    wake_history_press();
                    if (msg.reason) {
                        host_bridge.postMessage({ type: 'showWarning', message: msg.reason });
                    }
                    return;
                }
                let settled = false;
                // The document the admission was granted in: a refusal to
                // install it, if a replacement came first, is not about a press
                // made in the new one.
                const admitted_document = history_document_ref.current;
                // In flight for a press until the grid has installed it, or not.
                unsettled_admissions_ref.current.add(msg.requestId);
                pending.resolve({
                    rowIds: msg.rowIds,
                    formatTemplate: msg.formatTemplate,
                    structuralBasis: msg.structuralBasis,
                    appendBasis: msg.appendBasis,
                    settle: (accepted) => {
                        if (settled) return;
                        settled = true;
                        unsettled_admissions_ref.current.delete(msg.requestId);
                        // The grid did not install what was admitted: the
                        // person's own gesture recorded nothing, and a press
                        // held behind it was for its step.
                        if (!accepted && history_document_ref.current === admitted_document) {
                            drop_press_behind_unrecorded_gesture();
                        }
                        wake_history_press();
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: pending.editSessionId,
                            accepted,
                        });
                    },
                });
            } else if (msg.type === 'appendRowsResult') {
                const pending = pending_append_requests_ref.current.get(msg.requestId);
                if (pending === undefined || pending.kind !== 'append') return;
                pending_append_requests_ref.current.delete(msg.requestId);
                if (pending_append_requests_ref.current.size === 0) {
                    set_append_request_pending(false);
                }
                if (
                    msg.sourceGeneration !== pending.sourceGeneration
                    || msg.sourceGeneration !== source_generation_ref.current
                    || csv_edit_session_id_ref.current !== pending.editSessionId
                    || rendered_sheet_index_ref.current !== pending.sheetIndex
                    || !msg.granted
                    || msg.rowIds === undefined
                    || msg.formatTemplate === undefined
                    || msg.appendBasis === undefined
                ) {
                    if (msg.granted) {
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: pending.editSessionId,
                            accepted: false,
                        });
                    }
                    pending.resolve(undefined);
                    // The person's own gesture was refused, so nothing was recorded: a press
                    // held behind it was for its step, and would otherwise undo the one under it
                    // (as with Cancel).
                    drop_press_behind_unrecorded_gesture();
                    wake_history_press();
                    if (msg.reason) {
                        host_bridge.postMessage({ type: 'showWarning', message: msg.reason });
                    }
                    return;
                }
                let settled = false;
                // The document the admission was granted in: a refusal to
                // install it, if a replacement came first, is not about a press
                // made in the new one.
                const admitted_document = history_document_ref.current;
                // In flight for a press until the grid has installed it, or not.
                unsettled_admissions_ref.current.add(msg.requestId);
                pending.resolve({
                    rowIds: msg.rowIds,
                    formatTemplate: msg.formatTemplate,
                    appendBasis: msg.appendBasis,
                    settle: (accepted) => {
                        if (settled) return;
                        settled = true;
                        unsettled_admissions_ref.current.delete(msg.requestId);
                        // The grid did not install what was admitted: the
                        // person's own gesture recorded nothing, and a press
                        // held behind it was for its step.
                        if (!accepted && history_document_ref.current === admitted_document) {
                            drop_press_behind_unrecorded_gesture();
                        }
                        wake_history_press();
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: pending.editSessionId,
                            accepted,
                        });
                    },
                });
            } else if (msg.type === 'restoreSavedRowsResult') {
                const pending = pending_saved_row_restorations_ref.current.get(msg.requestId);
                if (pending === undefined) return;
                pending_saved_row_restorations_ref.current.delete(msg.requestId);
                const ids_match = msg.appendHistoryIds !== undefined
                    && JSON.stringify(msg.appendHistoryIds)
                        === JSON.stringify(pending.expectedIds);
                const current = msg.sourceGeneration === pending.sourceGeneration
                    && msg.sourceGeneration === source_generation_ref.current
                    && csv_edit_session_id_ref.current === pending.editSessionId;
                const admission_is_current = current
                    && msg.granted
                    && ids_match
                    && msg.appendBasis !== undefined;
                if (!admission_is_current) {
                    if (msg.granted) {
                        host_bridge.postMessage({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: pending.editSessionId,
                            accepted: false,
                        });
                    }
                    pending.resolve(undefined);
                } else {
                    let settled = false;
                    pending.resolve({
                        requestId: msg.requestId,
                        appendBasis: msg.appendBasis!,
                        settle: (accepted) => {
                            if (settled) return;
                            settled = true;
                            host_bridge.postMessage({
                                type: 'settleRowAdmission',
                                requestId: msg.requestId,
                                editSessionId: pending.editSessionId,
                                accepted,
                            });
                        },
                    });
                }
                if (!admission_is_current && msg.reason) {
                    host_bridge.postMessage({ type: 'showWarning', message: msg.reason });
                }
            } else if (msg.type === 'tailRemovalReplayValidated') {
                const pending = pending_tail_removal_validations_ref.current.get(msg.requestId);
                if (pending === undefined) return;
                pending_tail_removal_validations_ref.current.delete(msg.requestId);
                pending.resolve(
                    msg.valid
                    && msg.sourceGeneration === pending.sourceGeneration
                    && msg.sourceGeneration === source_generation_ref.current,
                );
            } else if (msg.type === 'discardEditSessionResult') {
                const pending = discard_cleanup_ref.current;
                if (pending !== undefined && pending.session === msg.editSessionId) {
                    discard_cleanup_ref.current = undefined;
                    pending.settle(msg.cleared);
                    // The header queue waits on this cleanup, and the snapshot
                    // that preceded this answer has already rendered.
                    wake_header_drain();
                }
            } else if (msg.type === 'editSessionRevoked') {
                apply_save_lifecycle(msg.lifecycle);
            } else if (msg.type === 'toolbarAnnouncement') {
                set_excel_header_status(msg.message);
            } else if (msg.type === 'saveResult') {
                const proposed_operation = save_projection_ref.current.operation;
                const transition = apply_save_lifecycle(msg.lifecycle);
                // Lifecycle revision is the ordering authority for the whole result,
                // not just its projection. A stale terminal must not clear or replace
                // the verdict installed by a later accepted result.
                const authoritative = transition.next.authoritative;
                const receipt_operation = msg.lifecycle.state === 'succeeded'
                    && msg.receipt !== undefined
                    && authoritative.state === 'succeeded'
                    && authoritative.revision === msg.lifecycle.revision
                    && csv_save_operations_equal(
                        authoritative.operation,
                        msg.lifecycle.operation,
                    )
                    ? proposed_operation !== undefined
                        && terminal_csv_save_settles_operation(
                            msg.lifecycle,
                            proposed_operation,
                        )
                        ? proposed_operation
                        : msg.lifecycle.operation
                    : undefined;
                const receipt_applied = receipt_operation !== undefined
                    && msg.receipt !== undefined
                    && apply_save_receipt(
                        receipt_operation,
                        msg.receipt,
                        msg.lifecycle.revision,
                    );
                if (!transition.changed && !receipt_applied) return;
                const operation = proposed_operation ?? receipt_operation;
                const current_session_id = csv_edit_session_id_ref.current;
                const matching = receipt_applied || (operation
                    ? terminal_csv_save_settles_operation(msg.lifecycle, operation)
                    : current_session_id === undefined
                        || save_lifecycle_correlation(msg.lifecycle)?.editSessionId
                            === current_session_id);
                if (!matching) return;
                const pending_grid_focus = pending_save_grid_focus_ref.current;
                const restore_rejected_grid_focus = operation !== undefined
                    && pending_grid_focus?.editSessionId === operation.editSessionId
                    && pending_grid_focus.saveRequestId === operation.saveRequestId
                    && !has_surviving_focus_target();
                pending_save_grid_focus_ref.current = null;

                // A success or a retry that passed dirty-base validation supersedes
                // any prior verdict. An earlier transient failure with no valid
                // rejection does not: the previously judged map is still live, and
                // `live_rejected_keys` expires keys when their identity changes.
                if (
                    msg.lifecycle.state === 'succeeded'
                    || msg.basesValidated === true
                ) clear_save_verdict();

                const rejection = is_wire_csv_save_rejection(msg.rejection)
                    ? msg.rejection
                    : undefined;
                // Adopt the host's named keys only for our own session: a rejection
                // for someone else's session names keys our store does not hold, and
                // a banner over them would offer a discard that does nothing. Ride
                // in on the lifecycle rather than a separate message so the map has
                // already been restored above (see CsvSaveRejection in types.ts).
                if (
                    rejection
                    && msg.lifecycle.state === 'failed'
                    && 'operation' in msg.lifecycle
                    && msg.lifecycle.operation.editSessionId === current_session_id
                ) {
                    const submitted_worksheet = save_operation_worksheets(
                        msg.lifecycle.operation,
                    )[rejection.worksheetOperationIndex];
                    if (!submitted_worksheet) return;
                    if (rejection.reason === 'structuralConflict') {
                        const sheets = meta_ref.current?.sheets ?? [];
                        const rejected_sheet_index = worksheet_target_index(
                            sheets,
                            submitted_worksheet,
                        );
                        if (rejected_sheet_index === undefined) return;
                        const store = edit_session_registry_ref.current!
                            .pending_rows_for_sheet(rejected_sheet_index);
                        const current = store.snapshot();
                        // A save may name thousands of affected formulas. Retain a
                        // bounded actionable slice; clearing it and retrying causes
                        // the host to recompute the next slice. Never replace exact
                        // cell identities with an addressless summary — such a
                        // conflict has no review action and cannot be resolved.
                        const formula_cells = rejection.formulaCells?.slice(0, 16);
                        const actionable_conflict = Object.freeze({
                            reason: rejection.structuralReason,
                            pendingRowIds: Object.freeze(formula_cells === undefined
                                ? rejection.pendingRowIds.slice(0, 16)
                                : [...new Set(formula_cells.flatMap((cell) =>
                                    cell.rowIdentity.kind === 'pending'
                                        ? [cell.rowIdentity.pendingRowId]
                                        : []))]),
                            tailRemovalIds: Object.freeze(
                                rejection.tailRemovalIds.slice(0, 16),
                            ),
                            ...(formula_cells === undefined ? {} : {
                                formulaCells: Object.freeze(formula_cells),
                            }),
                            ...(rejection.message === undefined ? {} : { message: rejection.message }),
                        });
                        // A Structural Basis conflict belongs to the whole
                        // worksheet; its action is a discard, not a row.
                        if (
                            !WORKSHEET_LEVEL_STRUCTURAL_CONFLICTS.has(actionable_conflict.reason)
                            && actionable_conflict.pendingRowIds.length === 0
                            && actionable_conflict.tailRemovalIds.length === 0
                            && (actionable_conflict.formulaCells?.length ?? 0) === 0
                        ) {
                            host_bridge.postMessage({
                                type: 'showWarning',
                                message: 'The host returned a structural conflict without an affected cell or row.',
                            });
                            return;
                        }
                        const live_cells = Object.fromEntries(
                            [...edit_session_registry_ref.current!
                                .for_sheet(rejected_sheet_index).snapshot()].map(
                                ([key, entry]) => [key, copy_dirty_entry(entry)],
                            ),
                        );
                        const retained_conflicts = current.conflicts.filter((candidate) =>
                            candidate.reason !== rejection.structuralReason);
                        const fits = (
                            conflict: typeof actionable_conflict,
                            conflicts = retained_conflicts,
                        ): boolean => {
                            try {
                                assert_pending_changes_encoded_bound({
                                    sheetIndex: submitted_worksheet.sheetIndex,
                                    ...(submitted_worksheet.sheetName === undefined
                                        ? {}
                                        : { sheetName: submitted_worksheet.sheetName }),
                                    ...(submitted_worksheet.worksheetId === undefined
                                        ? {}
                                        : { worksheetId: submitted_worksheet.worksheetId }),
                                    cells: live_cells,
                                    ...current,
                                    conflicts: [...conflicts, conflict],
                                });
                                return true;
                            } catch {
                                return false;
                            }
                        };
                        const existing_exact = current.conflicts.find((candidate) =>
                            JSON.stringify(candidate) === JSON.stringify(actionable_conflict));
                        const conflict = existing_exact ?? (fits(actionable_conflict)
                            ? actionable_conflict
                            : fits(actionable_conflict, []) ? actionable_conflict : undefined);
                        if (conflict === undefined) {
                            host_bridge.postMessage({
                                type: 'showWarning',
                                message: 'The conflict could not be retained because Pending Changes reached its size limit.',
                            });
                            return;
                        }
                        const duplicate = current.conflicts.some((candidate) =>
                            JSON.stringify(candidate) === JSON.stringify(conflict));
                        if (!duplicate) {
                            const base = fits(conflict) ? retained_conflicts : [];
                            store.reconcile(
                                { session_id: msg.lifecycle.operation.editSessionId },
                                { ...current, conflicts: [...base, conflict] },
                            );
                        }
                        clear_save_verdict();
                        if (rejected_sheet_index !== rendered_sheet_index_ref.current) {
                            if (
                                grid_focus_ref.current?.has_focus() === true
                                || restore_rejected_grid_focus
                            ) {
                                rejected_sheet_grid_focus_ref.current = {
                                    sheet_index: rejected_sheet_index,
                                    generation: generation_ref.current,
                                    document_epoch: document_epoch_ref.current,
                                };
                            }
                            handle_sheet_select(rejected_sheet_index);
                        } else if (restore_rejected_grid_focus) {
                            grid_focus_ref.current?.focus();
                        }
                        return;
                    }
                    const submitted = submitted_worksheet.dirtyEdits;
                    clear_save_verdict();
                    set_save_rejection({
                        reason: rejection.reason,
                        keys: [...rejection.keys],
                        session_id: current_session_id,
                        sheet_index: submitted_worksheet.sheetIndex,
                        sheet_name: submitted_worksheet.sheetName,
                        worksheet_id: submitted_worksheet.worksheetId,
                        // Snapshot what the host actually judged, from the operation
                        // it judged it over rather than from the live map, which may
                        // already have moved on. `live_rejected_keys` compares against
                        // this so a key that came back with a different value or a
                        // re-read base is understood as a new, unjudged edit.
                        // The full entry, runs included: a formatting-only
                        // replacement is a new, unjudged edit, so identity must
                        // cover the run sides too.
                        entries: Object.fromEntries(
                            rejection.keys.map((key) => [
                                key,
                                submitted[key] ?? { value: '', base: '' },
                            ]),
                        ),
                        ...(rejection.observedBases !== undefined
                            ? { observed_bases: rejection.observedBases }
                            : {}),
                        ...(rejection.removedKeys !== undefined
                            ? { removed_keys: rejection.removedKeys }
                            : {}),
                    });
                    // Saving is workbook-wide. If validation found the affected
                    // draft on another worksheet, move there so the informational
                    // review is visible instead of leaving the user on a clean tab
                    // with no explanation for the failed save.
                    const rejected_sheet_index = worksheet_target_index(
                        meta_ref.current?.sheets ?? [],
                        submitted_worksheet,
                    );
                    if (
                        rejected_sheet_index !== undefined
                        && rejected_sheet_index !== rendered_sheet_index_ref.current
                    ) {
                        if (
                            grid_focus_ref.current?.has_focus() === true
                            || restore_rejected_grid_focus
                        ) {
                            rejected_sheet_grid_focus_ref.current = {
                                sheet_index: rejected_sheet_index,
                                generation: generation_ref.current,
                                document_epoch: document_epoch_ref.current,
                            };
                        }
                        handle_sheet_select(rejected_sheet_index);
                    } else if (
                        rejected_sheet_index === rendered_sheet_index_ref.current
                        && restore_rejected_grid_focus
                    ) {
                        grid_focus_ref.current?.focus();
                    }
                }
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [
        advance_edit_activation,
        apply_save_receipt,
        apply_save_lifecycle,
        install_edit_session,
        handle_sheet_select,
        persist_immediate,
        run_edit_command,
        settle_session_grant_waiters,
    ]);

    // If editing becomes unavailable (e.g. a reload disables CSV editing), let
    // the session go so the toolbar and banners don't dangle.
    useEffect(() => {
        if (editing_session_held && !csv_editable) end_editing_session();
    }, [editing_session_held, csv_editable, end_editing_session]);

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
        set_editing_status_sheet_index(active_sheet_index);
        set_editing_status(status);
    }, [active_sheet_index]);

    const handle_highlight_selection = useCallback((
        selection: CellHighlightSelection,
        mutation: CellHighlightMutation,
        pending_gesture?: PendingHostGesture,
    ) => {
        const sheet = meta_ref.current?.sheets[active_sheet_index];
        const identity = snapshot_identity_ref.current;
        if (
            !sheet
            || !identity
            || preview_mode_ref.current
            || pending_highlight_request_ref.current
        ) {
            pending_gesture?.cancel();
            return;
        }
        // Highlight admission makes every cell read-only until the host replies.
        // Glide does not reliably close an overlay it already mounted when
        // provideEditor changes, so fold and terminate it before reserving the
        // history slot. Doing this after setting the pending ref would make the
        // gesture gate reject the user's already-typed text.
        if (editing_ref.current?.commit_live_edit() === false) {
            pending_gesture?.cancel();
            return;
        }
        const request_id = [
            'highlight',
            highlight_request_prefix_ref.current,
            ++highlight_request_seq_ref.current,
        ].join(':');
        // The gesture's own name goes with the request: the diff that comes back
        // says which cells moved but not what the user asked for, and "Undo Clear
        // highlight" reads as the action they took.
        pending_highlight_request_ref.current = {
            requestId: request_id,
            label: mutation.type === 'clear' ? 'Clear highlight' : 'Highlight cells',
            ...(pending_gesture === undefined ? {} : { pendingGesture: pending_gesture }),
        };
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
        if (refused_for_reopen()) return;
        if (!edit_gestures_admitted()) {
            // Said only while a press of Undo or Redo is waiting.
            if (history_press_held()) say_history_hold_gesture();
            return;
        }
        if (editing_ref.current?.commit_live_edit() === false) return;
        const request_id = [
            'highlight',
            highlight_request_prefix_ref.current,
            ++highlight_request_seq_ref.current,
        ].join(':');
        pending_highlight_request_ref.current = {
            requestId: request_id,
            label: 'Clear all highlights',
        };
        set_highlight_request_pending(true);
        set_highlight_status('Updating cell highlights…');
        host_bridge.postMessage({
            type: 'clearAllCellHighlights',
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
            snapshotIdentity: identity,
        });
    }, [edit_gestures_admitted, history_press_held, refused_for_reopen, say_history_hold_gesture]);

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
        // A direct resize keeps every current width, Pending Columns' too.
        pending_auto_fit_snapshot_ref.current[sheet_index] = undefined;
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

    /** Set a worksheet's Auto-fit: on with the widths its restore puts back, or off. */
    const set_auto_fit_for_sheet = useCallback((
        sheet_index: number,
        active: boolean,
        snapshot: Record<number, number> | undefined,
    ) => {
        const next_active = [...auto_fit_active_ref.current];
        const next_snapshot = [...auto_fit_snapshot_ref.current];
        next_active[sheet_index] = active;
        next_snapshot[sheet_index] = active ? snapshot : undefined;
        auto_fit_active_ref.current = next_active;
        auto_fit_snapshot_ref.current = next_snapshot;
        set_auto_fit_active(next_active);
        set_auto_fit_snapshot(next_snapshot);
    }, []);

    /** Auto-fit's own state as it is now, for a caller about to drop some of it. */
    const auto_fit_extras = useCallback((): AutoFitExtras => ({
        owed: pending_auto_fit_sheets_ref.current,
        pendingColumnSnapshots: [...pending_auto_fit_snapshot_ref.current],
    }), []);
    const width_write_seq_ref = useRef(0);
    /**
     * Sheets whose owed fit the host refused, held until the next snapshot is
     * applied: retrying under the conditions that refused it would post and
     * be refused in a loop.
     */
    const owed_fit_held_ref = useRef<ReadonlySet<number>>(new Set());
    /**
     * Show column widths at once and ask the host to make them durable,
     * keeping the pending write its answer settles. Answers false when it
     * could not be posted.
     *
     * The one writer behind a border drag, a double-click fit, Auto-fit on
     * and off, and a width step's replay. A width is not written through
     * `stateChanged`: that message has no answer and is refused whenever a
     * delivery is in flight. History never moves, and no step is recorded,
     * on a write that may not have happened, and the step is what the host
     * says it changed (`settle_width_write`).
     */
    const post_column_widths = useCallback((
        sheets: readonly WidthWriteSheet[],
        options: {
            readonly replay?: ViewReplay;
            readonly owed?: boolean;
            /** Read by the caller before it dropped any of it: see `PendingWidthWrite`. */
            readonly auto_fit_extras_before?: AutoFitExtras;
        } = {},
    ): boolean => {
        const meta_sheets = meta_ref.current?.sheets;
        if (meta_sheets === undefined) return false;
        if (sheets.every((entry) => entry.widths.length === 0)) return false;
        if (sheets.some((entry) => meta_sheets[entry.sheet_index] === undefined)) return false;
        // One at a time. Every caller is admitted first (a gesture by
        // `size_gesture_may_start`, a replay by `history_free`); this keeps a
        // second write from displacing the record the first one's answer settles.
        if (pending_width_write_ref.current !== null) return false;
        const widths = [...(state_ref.current.columnWidths ?? [])];
        const pending_sheets: PendingWidthSheet[] = [];
        for (const entry of sheets) {
            const sheet = meta_sheets[entry.sheet_index]!;
            const before = widths[entry.sheet_index];
            const next: Record<number, number> = { ...(before ?? {}) };
            const shown: { column: number; width: number | null }[] = [];
            for (const { column, width } of entry.widths) {
                shown.push({
                    column,
                    width: before !== undefined && Object.prototype.hasOwnProperty.call(before, column)
                        ? before[column]
                        : null,
                });
                if (width === null) delete next[column];
                else next[column] = width;
            }
            const posted = Object.keys(next).length === 0 ? undefined : next;
            widths[entry.sheet_index] = posted;
            pending_sheets.push({
                worksheet: {
                    sheetIndex: entry.sheet_index,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                },
                shown,
                posted,
                autoFitBefore: {
                    active: auto_fit_active_ref.current[entry.sheet_index] === true,
                    snapshot: auto_fit_snapshot_ref.current[entry.sheet_index],
                },
                ...(entry.auto_fit_change === undefined ? {} : { autoFit: entry.auto_fit_change }),
                ...(entry.pending_column_widths_before === undefined
                    ? {}
                    : { pendingColumnWidthsBefore: entry.pending_column_widths_before }),
            });
        }
        state_ref.current = { ...state_ref.current, columnWidths: widths };
        set_column_widths(widths);
        for (const entry of sheets) {
            set_auto_fit_for_sheet(
                entry.sheet_index,
                entry.auto_fit.active,
                entry.auto_fit.active ? entry.auto_fit.snapshot : undefined,
            );
        }
        const request_id = [
            'widths',
            highlight_request_prefix_ref.current,
            ++width_write_seq_ref.current,
        ].join(':');
        pending_width_write_ref.current = {
            requestId: request_id,
            sourceGeneration: source_generation_ref.current,
            sheets: pending_sheets,
            ...(options.replay === undefined ? {} : { replay: options.replay }),
            ...(options.auto_fit_extras_before === undefined
                ? {}
                : { autoFitExtrasBefore: options.auto_fit_extras_before }),
            owed: options.owed === true,
            snapshotAdopted: false,
        };
        sync_view_request_pending();
        if (options.replay !== undefined) watch_view_replay(request_id, options.replay.direction);
        host_bridge.postMessage({
            type: 'setColumnWidths',
            requestId: request_id,
            sourceGeneration: source_generation_ref.current,
            // A sheet with no widths is the caller's to settle with the rest
            // and nothing to ask the host for.
            sheets: sheets.filter((entry) => entry.widths.length > 0).map((entry) => ({
                sheetIndex: entry.sheet_index,
                sheetName: meta_sheets[entry.sheet_index]!.name,
                widths: entry.widths.map(({ column, width }) => ({ column, width })),
            })),
        });
        return true;
    }, [set_auto_fit_for_sheet, sync_view_request_pending]);

    /**
     * Settle a column-width write.
     *
     * Applied: a gesture records its step from what the host says it changed
     * (one change per worksheet, in one action), and nothing when it changed
     * nothing; a replay moves its entry. Neither writes the view: after the
     * post only a snapshot changes what the sheet shows, and the delivery
     * ahead of the answer carried what is durable.
     *
     * Refused: nothing was written. The columns and Auto-fit are put back,
     * unless a snapshot has adopted widths since the post; then the widths
     * are already the host's.
     *
     * While the write was pending, the snapshot handler did not apply "a
     * refresh whose widths differ ends Auto-fit" to these sheets, because a
     * refresh captured before the commit differs by construction. It is
     * applied here: if a snapshot was adopted and a sheet's widths are no
     * longer what the window showed after the post, something else wrote them.
     */
    const settle_width_write = useCallback((
        pending: PendingWidthWrite,
        outcome: WidthWriteOutcome,
    ) => {
        const meta_sheets = meta_ref.current?.sheets ?? [];
        const index_of = (sheet: PendingWidthSheet) => worksheet_target_index(meta_sheets, sheet.worksheet);
        if (outcome.kind === 'overtaken') {
            if (pending.replay !== undefined) {
                // A refresh of another source overtook the write: tried
                // again against what that refresh brought.
                hand_over_history_retry(pending.replay.press, pending.replay.entry, pending.replay.posted_after);
            } else if (!pending.owed) {
                // Nothing recorded for the person's own gesture: a press held behind it
                // was for its step, and would otherwise undo the one under it (as with Cancel).
                // (An owed fit is nobody's gesture: a press held behind it runs.)
                drop_press_behind_unrecorded_gesture();
            }
            return;
        }
        const end_superseded_auto_fit = (refused: boolean) => {
            if (!pending.snapshotAdopted) return;
            for (const sheet of pending.sheets) {
                const index = index_of(sheet);
                if (index === undefined) continue;
                if (
                    refused
                    || !sheet_widths_equal(state_ref.current.columnWidths?.[index], sheet.posted)
                ) {
                    set_auto_fit_for_sheet(index, false, undefined);
                    // With the fit goes what its restore would put back on
                    // the Pending Columns, as where a refresh ends Auto-fit.
                    pending_auto_fit_snapshot_ref.current[index] = undefined;
                }
            }
        };
        if (outcome.kind === 'applied') {
            end_superseded_auto_fit(false);
            if (pending.owed) {
                for (const sheet of pending.sheets) {
                    const index = index_of(sheet);
                    if (index !== undefined) cancel_pending_auto_fit_for_sheet(index);
                }
            }
            if (pending.replay !== undefined) {
                land_view_replay(pending.replay, pending.sheets[0]!.worksheet, false);
                return;
            }
            const changes: { kind: 'view'; delta: ViewHistoryDelta }[] = [];
            let columns = 0;
            let auto_fit: AutoFitChange | undefined;
            let resolved = 0;
            for (const sheet_change of outcome.change) {
                const sheet = meta_sheets[sheet_change.sheetIndex];
                // A worksheet a reload removed since the post has no step.
                const pending_sheet = pending.sheets.find(
                    (candidate) => index_of(candidate) === sheet_change.sheetIndex,
                );
                if (sheet === undefined || pending_sheet === undefined) continue;
                resolved += 1;
                const step = column_widths_view_step(
                    {
                        sheetIndex: sheet_change.sheetIndex,
                        sheetName: sheet.name,
                        ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                    },
                    sheet_change.columns,
                    pending_sheet.autoFit,
                );
                if (step === undefined) continue;
                changes.push({ kind: 'view', delta: step.delta });
                columns += sheet_change.columns.length;
                auto_fit ??= pending_sheet.autoFit;
            }
            if (changes.length === 0) {
                // Every worksheet it changed is gone: the person's own gesture
                // recorded nothing it should have. (A write that changed
                // nothing is no failure.)
                if (!pending.owed && outcome.change.length > 0 && resolved === 0) drop_press_behind_unrecorded_gesture();
                return;
            }
            const record = history_store_ref.current!.stage_record({
                label: column_widths_label(columns, auto_fit),
                changes,
            });
            commit_staged_transaction([record]);
            return;
        }
        // The Pending Columns go back with the toolbar. They were sized with
        // the saved columns, ahead of the answer. A refused fit leaves the
        // toolbar off whether or not a snapshot arrived meanwhile; a refused
        // restore leaves it on only when none did, and off otherwise, which
        // is where the restored Pending Columns already are.
        for (const sheet of pending.sheets) {
            if (sheet.pendingColumnWidthsBefore === undefined) continue;
            if (pending.snapshotAdopted && sheet.autoFit !== 'on') continue;
            const index = index_of(sheet);
            if (index !== undefined) write_pending_column_widths(index, sheet.pendingColumnWidthsBefore);
        }
        if (pending.snapshotAdopted) {
            end_superseded_auto_fit(true);
        } else {
            const widths = [...(state_ref.current.columnWidths ?? [])];
            for (const sheet of pending.sheets) {
                const index = index_of(sheet);
                if (index === undefined) continue;
                const next: Record<number, number> = { ...(widths[index] ?? {}) };
                for (const { column, width } of sheet.shown) {
                    if (width === null) delete next[column];
                    else next[column] = width;
                }
                widths[index] = Object.keys(next).length === 0 ? undefined : next;
                set_auto_fit_for_sheet(index, sheet.autoFitBefore.active, sheet.autoFitBefore.snapshot);
            }
            state_ref.current = { ...state_ref.current, columnWidths: widths };
            set_column_widths(widths);
            if (pending.autoFitExtrasBefore !== undefined) {
                update_pending_auto_fit_sheets(pending.autoFitExtrasBefore.owed);
                pending_auto_fit_snapshot_ref.current = [
                    ...pending.autoFitExtrasBefore.pendingColumnSnapshots,
                ];
            }
        }
        if (pending.owed) {
            // Nobody pressed anything, so nothing is said; the fit stays owed
            // and waits for the next snapshot.
            const held = new Set(owed_fit_held_ref.current);
            for (const sheet of pending.sheets) {
                const index = index_of(sheet);
                if (index !== undefined) held.add(index);
            }
            owed_fit_held_ref.current = held;
            return;
        }
        if (pending.replay !== undefined) {
            if (outcome.unresolved) {
                refuse_history_press(view_replay_refusal_warning(
                    pending.replay.direction,
                    pending.replay.entry.action.label,
                    UNRESOLVED_SAVE_SIZE_REASON,
                ));
            } else {
                hand_over_history_retry(pending.replay.press, pending.replay.entry, pending.replay.posted_after);
            }
        } else {
            show_warning(outcome.unresolved ? SIZE_WRITE_UNRESOLVED_MESSAGE : SIZE_WRITE_REFUSED_MESSAGE);
            // The person's own gesture was refused, so nothing was recorded: a press
            // held behind it was for its step, and would otherwise undo the one under it
            // (as with Cancel).
            drop_press_behind_unrecorded_gesture();
        }
    }, [
        cancel_pending_auto_fit_for_sheet,
        drop_press_behind_unrecorded_gesture,
        hand_over_history_retry,
        land_view_replay,
        refuse_history_press,
        set_auto_fit_for_sheet,
        show_warning,
        update_pending_auto_fit_sheets,
        write_pending_column_widths,
    ]);
    settle_width_write_ref.current = settle_width_write;
    post_column_widths_ref.current = post_column_widths;

    /**
     * Whether a resize, reset, or Auto-fit change the person just made may be
     * written now, having folded the open editor.
     *
     * A size gesture is a view gesture: one at a time, and never while a save
     * is in flight (a structural save renumbers the rows and columns a size
     * names and cuts history off, and an answer arriving after it would
     * record a step in the old numbering). Refused, it always says why: a
     * border that springs back needs a reason.
     */
    const size_gesture_may_start = useCallback((): boolean => {
        if (refused_for_reopen()) return false;
        if (fold_before_view_request() === 'refused') return false;
        if (save_in_flight_ref.current || !edit_gestures_admitted()) {
            show_warning(VIEW_GESTURE_WAIT_MESSAGE);
            return false;
        }
        return true;
    }, [edit_gestures_admitted, fold_before_view_request, refused_for_reopen, show_warning]);

    const column_write_seq_ref = useRef(0);
    /**
     * Show one worksheet's columns as `after` and ask the host to make it
     * durable, keeping the pending write its answer settles. Answers false
     * when it could not be posted (no snapshot identity yet).
     *
     * The one writer behind the column gestures and a column step's replay.
     * History never moves, and no step is recorded, on a write that may not
     * have happened: the host can decline it, so it is asked for an answer
     * (`columnVisibilityChanged`) and `settle_column_write` acts on that.
     *
     * Ends auto-fit for the sheet whichever way it is reached: changing which
     * columns show is what makes the fitted widths stale.
     */
    const post_column_visibility = useCallback((
        sheet_index: number,
        before: SheetColumnVisibilityState | undefined,
        after: SheetColumnVisibilityState | undefined,
        replay?: ViewReplay,
    ): boolean => {
        const sheet = meta_ref.current?.sheets[sheet_index];
        const snapshot_identity = snapshot_identity_ref.current;
        if (!sheet || !snapshot_identity) return false;
        deactivate_auto_fit_for_sheet(sheet_index);
        const next_visibility = [
            ...(state_ref.current.columnVisibility ?? []),
        ];
        next_visibility[sheet_index] = after;
        state_ref.current = {
            ...state_ref.current,
            columnVisibility: next_visibility,
        };
        set_column_visibility(next_visibility);
        const request_id = [
            'columns',
            highlight_request_prefix_ref.current,
            ++column_write_seq_ref.current,
        ].join(':');
        pending_column_write_ref.current = {
            requestId: request_id,
            worksheet: {
                sheetIndex: sheet_index,
                sheetName: sheet.name,
                ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
            },
            schema: transform_schema_for_sheet(sheet),
            sourceGeneration: source_generation_ref.current,
            before,
            after,
            ...(replay === undefined ? {} : { replay }),
            snapshotAdopted: false,
        };
        sync_view_request_pending();
        host_bridge.postMessage({
            type: 'setColumnVisibility',
            sheetIndex: sheet_index,
            sheetName: sheet.name,
            state: after,
            sourceGeneration: source_generation_ref.current,
            snapshotIdentity: snapshot_identity,
            requestId: request_id,
        });
        persist_immediate();
        return true;
    }, [deactivate_auto_fit_for_sheet, persist_immediate, sync_view_request_pending]);
    post_column_visibility_ref.current = post_column_visibility;

    const update_column_visibility = useCallback((
        updater: ColumnVisibilityUpdater,
    ) => {
        const sheet = meta?.sheets[active_sheet_index];
        if (!sheet || !snapshot_identity_ref.current) return;
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
        // A gesture that changes nothing folds no open editor and says nothing.
        if (column_visibility_equal(current, next_sheet_visibility)) return;
        if (!view_gesture_may_start(undefined)) return;
        post_column_visibility(active_sheet_index, current, next_sheet_visibility);
    }, [
        active_sheet_index,
        meta,
        post_column_visibility,
        view_gesture_may_start,
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

    /**
     * A finished column-width gesture on the active sheet: a border drag (with
     * the columns it was fanned out to) or a double-click fit. One write, and
     * one step in undo history once the host has applied it.
     *
     * GridShell asked `size_gesture_may_start` before reporting it.
     */
    const handle_columns_resized = useCallback(
        (changes: readonly { readonly column: number; readonly width: number }[]) => {
            if (changes.length === 0) return;
            // A direct resize supersedes both active and still-pending auto-fit.
            // Keep the current widths, Pending Columns' too, and discard any
            // restore snapshot or owed fit. A resize the host refuses did not
            // happen, so they come back with the widths.
            const auto_fit_extras_before = auto_fit_extras();
            cancel_pending_auto_fit_for_sheet(active_sheet_index);
            pending_auto_fit_snapshot_ref.current[active_sheet_index] = undefined;
            post_column_widths([{
                sheet_index: active_sheet_index,
                widths: changes,
                auto_fit: { active: false },
            }], { auto_fit_extras_before });
        },
        [active_sheet_index, auto_fit_extras, cancel_pending_auto_fit_for_sheet, post_column_widths],
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
        (
            rows: readonly DisplayRowInterval[],
            // `null` resets the rows: each loses its custom height.
            height: number | null,
            { gesture, on_result }: {
                /**
                 * A resize or reset the person made. It is answered, and its
                 * step in undo history is what the answer says changed: only
                 * the host knows which source rows these display rows are and
                 * what they held. The row a committed edit grows is not one.
                 */
                readonly gesture: boolean;
                readonly on_result?: (applied: boolean) => void;
            },
        ) => {
            if (height !== null && !Number.isFinite(height)) {
                on_result?.(false);
                return;
            }
            let requested_rows = 0;
            for (const interval of rows) {
                requested_rows += interval.end - interval.start + 1;
            }
            if (requested_rows === 0) {
                on_result?.(false);
                return;
            }
            // Clamped here as well as host-side, and not merely for symmetry: the overlay
            // is reconciled against the delivered projection by *value*, so an
            // unclamped optimistic height would never match the clamped height the host
            // stores, and the layer would sit there masking it. The drag itself already
            // clamps (`row-resize-model`), so this is the case that should not arise
            // rather than one that does.
            const clamped = height === null ? null : clamp_row_height(height);
            // Every write is answered, so a refused one never leaves its
            // height painted. Only a gesture, or a write Pending Rows wait on,
            // is also waited for here: the row a committed edit grows holds
            // no gate and records no step, so its answer finds no entry and
            // retires its layer.
            const request_id = [
                'row-resize',
                highlight_request_prefix_ref.current,
                ++row_resize_request_seq_ref.current,
            ].join(':');
            if (gesture || on_result !== undefined) {
                const sheet = meta_ref.current?.sheets[active_sheet_index];
                pending_row_resize_requests_ref.current.set(request_id, {
                    sourceGeneration: source_generation_ref.current,
                    worksheet: sheet === undefined ? undefined : {
                        sheetIndex: active_sheet_index,
                        sheetName: sheet.name,
                        ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                    },
                    gesture,
                    ...(on_result === undefined ? {} : { finish: on_result }),
                });
                sync_view_request_pending();
            }
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
                requestId: request_id,
            });
            // Posted either way, but painted optimistically only when the host can
            // actually keep it. Over the cap the host refuses the whole request and warns
            // the owner, delivering nothing — so an overlay layer for it would have no
            // delivery to reconcile against and would show a height nothing persisted
            // until its answer arrived. Better to let the row spring back as the
            // drag ends, which is the truth.
            //
            // The same cap applied to the *accumulated* durable map is a refusal this
            // panel cannot predict: it never holds that map, and the projection is not a
            // proxy for its size. The user is told (the host warns, naming the limit),
            // and the answer retires the layer painted below, so the row springs back:
            // a resize a person made, and the row a committed edit grew alike.
            //
            // A reset paints nothing ahead of the host either: which rows hold a
            // custom height is the host's to say, and they change with its delivery.
            // It only takes its place among the heights already painted.
            if (clamped === null) {
                mark_row_height_request(active_sheet_index, request_id);
                return;
            }
            if (requested_rows > MAX_PERSISTED_ROW_HEIGHTS) return;
            set_row_height_overlay((previous) => {
                // Tagged with its request: the answer retires it, whatever it says.
                const layer: RowHeightLayer = {
                    rows,
                    height: clamped,
                    requestId: request_id,
                };
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
        [active_sheet_index, mark_row_height_request, sync_view_request_pending]
    );

    /**
     * Fit the active sheet now, recording the widths it replaces.
     *
     * Reads the fit through `auto_fit_ref` rather than taking widths as an argument
     * because only a *mounted* grid can measure, and all three callers — the button,
     * the all-sheets action, and the deferred pass below — run against whichever grid
     * is mounted at the time. Answers what it did: nothing when the grid had
     * nothing to measure, a request posted for the host to answer, or the
     * toolbar turned on with no request when only Pending Columns were measured.
     */
    const apply_auto_fit_to_active_sheet = useCallback((
        // A fit owed to this sheet and applied now that it can be: nobody
        // pressed anything. It stays owed until its write is answered.
        owed = false,
    ): 'nothing-to-measure' | 'posted' | 'unchanged' => {
        const fitted = auto_fit_ref.current?.();
        const pending_fitted = pending_auto_fit_ref.current?.() ?? {};
        const pending_ids = Object.keys(pending_fitted);
        if (!fitted && pending_ids.length === 0) return 'nothing-to-measure';
        const sheet_index = active_sheet_index;
        // Read before the fit touches any of it: a fit the host refuses did
        // not happen, and this is what it puts back.
        const auto_fit_extras_before = auto_fit_extras();
        let pending_column_widths_before: Record<string, number | undefined> | undefined;
        if (pending_ids.length > 0) {
            const before = new Map((edit_session_registry_ref.current!
                .pending_rows_for_sheet(sheet_index).snapshot().pendingColumns ?? [])
                .map((column) => [column.id, column.viewerWidth]));
            // A copy: the one in the ref is what a refusal puts back.
            const snapshot = { ...(pending_auto_fit_snapshot_ref.current[sheet_index] ?? {}) };
            pending_column_widths_before = {};
            for (const id of pending_ids) {
                if (!Object.prototype.hasOwnProperty.call(snapshot, id)) snapshot[id] = before.get(id);
                pending_column_widths_before[id] = before.get(id);
            }
            pending_auto_fit_snapshot_ref.current[sheet_index] = snapshot;
            write_pending_column_widths(sheet_index, pending_fitted);
        }
        const current_widths = state_ref.current.columnWidths?.[sheet_index];
        // The widths a restore puts back: the ones this fit replaces, unless
        // the sheet is already fitted. A second fit over a fitted sheet must
        // not overwrite the original widths with fitted ones, or "restore"
        // would restore the fit.
        const snapshot = auto_fit_snapshot_ref.current[sheet_index]
            ?? (current_widths ? { ...current_widths } : undefined);
        // Every measured width is asked for, whatever this window shows: its
        // copy can be behind what another window stored, and a column left
        // out for looking fitted here would keep that other width. Whether
        // anything changed, and so whether there is a step, is the host's
        // answer.
        const widths = Object.entries(fitted ?? {})
            .map(([column, width]) => ({ column: Number(column), width }));
        if (widths.length === 0) {
            // Only Pending Columns were measured: nothing to ask the host
            // for, so no step. The toolbar still turns on.
            set_auto_fit_for_sheet(sheet_index, true, snapshot);
            return 'unchanged';
        }
        post_column_widths([{
            sheet_index,
            widths,
            auto_fit: { active: true, snapshot },
            auto_fit_change: 'on',
            ...(pending_column_widths_before === undefined ? {} : { pending_column_widths_before }),
        }], { owed, auto_fit_extras_before });
        return 'posted';
    }, [
        active_sheet_index,
        auto_fit_extras,
        post_column_widths,
        set_auto_fit_for_sheet,
        write_pending_column_widths,
    ]);

    /**
     * Put the named sheets back on the widths their fit replaced: one write
     * for all of them, and one step.
     *
     * Serves both the button, which passes the active sheet alone, and the all-sheets
     * menu item. Sheets that were never fitted are skipped rather than blanked, so
     * passing every index is safe.
     *
     * A sheet's restore replaces its whole width map with the snapshot, so a
     * column the fit gave a width and that had none before loses it. The
     * request says that column by column: the snapshot's width for every
     * column in it, and no width for every column that has one now and is
     * not in the snapshot.
     */
    const restore_widths_for_sheets = useCallback((
        indices: readonly number[],
        // Auto-fit's own state from before the caller dropped any of it; read
        // here when the caller dropped nothing.
        auto_fit_extras_before: AutoFitExtras = auto_fit_extras(),
    ) => {
        const fitted = indices.filter((index) => auto_fit_active_ref.current[index]);
        if (fitted.length === 0) return;
        // The fitted widths each sheet's Pending Columns have now, which a
        // refused restore puts back.
        const pending_widths_before = new Map<number, Record<string, number | undefined>>();
        for (const index of fitted) {
            const pending = pending_auto_fit_snapshot_ref.current[index];
            pending_auto_fit_snapshot_ref.current[index] = undefined;
            if (pending === undefined) continue;
            const now = new Map((edit_session_registry_ref.current!
                .pending_rows_for_sheet(index).snapshot().pendingColumns ?? [])
                .map((column) => [column.id, column.viewerWidth]));
            pending_widths_before.set(
                index,
                Object.fromEntries(Object.keys(pending).map((id) => [id, now.get(id)])),
            );
            write_pending_column_widths(index, pending);
        }
        const writes: WidthWriteSheet[] = [];
        for (const index of fitted) {
            const current = state_ref.current.columnWidths?.[index] ?? {};
            const snapshot = auto_fit_snapshot_ref.current[index] ?? {};
            // Widths are kept by position, and a file that has since lost
            // columns leaves widths behind for positions it no longer has.
            // The host refuses a request that names one, so they are left
            // as they are, like the columns a replay leaves out.
            const column_count = meta_ref.current?.sheets[index]?.columnCount ?? 0;
            // Every width of the snapshot is asked for, not only those this
            // window shows as different: its copy can be behind what another
            // window stored. The host's answer says what changed.
            const widths: { column: number; width: number | null }[] = [];
            for (const [key, width] of Object.entries(snapshot)) {
                const column = Number(key);
                if (column < column_count) widths.push({ column, width });
            }
            for (const key of Object.keys(current)) {
                const column = Number(key);
                if (column < column_count && !Object.prototype.hasOwnProperty.call(snapshot, key)) {
                    widths.push({ column, width: null });
                }
            }
            // No width before the fit and none now leaves nothing to ask the
            // host for on this sheet. It goes with the others all the same:
            // its toolbar and Pending Columns are restored with theirs, and
            // put back with theirs if the host refuses.
            widths.sort((left, right) => left.column - right.column);
            const pending_column_widths_before = pending_widths_before.get(index);
            writes.push({
                sheet_index: index,
                widths,
                auto_fit: { active: false },
                auto_fit_change: 'off',
                ...(pending_column_widths_before === undefined ? {} : { pending_column_widths_before }),
            });
        }
        if (writes.some((write) => write.widths.length > 0)) {
            post_column_widths(writes, { auto_fit_extras_before });
            return;
        }
        // Nothing to ask the host for on any sheet, so nothing to refuse and
        // no step: only the toolbar turns off.
        for (const write of writes) set_auto_fit_for_sheet(write.sheet_index, false, undefined);
    }, [auto_fit_extras, post_column_widths, set_auto_fit_for_sheet, write_pending_column_widths]);

    /**
     * The toolbar's Auto-fit: fit the active sheet, or put its widths back.
     * A size gesture like a drag: while the window is not free it is not
     * started, and says so.
     */
    const handle_toggle_auto_fit = useCallback(() => {
        if (!size_gesture_may_start()) return;
        if (auto_fit_active_ref.current[active_sheet_index]) {
            restore_widths_for_sheets([active_sheet_index]);
        } else {
            apply_auto_fit_to_active_sheet();
        }
    }, [
        active_sheet_index,
        apply_auto_fit_to_active_sheet,
        restore_widths_for_sheets,
        size_gesture_may_start,
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

    /**
     * Apply the fit "Auto-fit columns on all sheets" owes the active sheet,
     * once it can be.
     *
     * The fit is a step like any other, and nobody is pressing anything when
     * it lands. So it waits until the window is free, no cell editor or menu
     * is open (it never folds one), and there is nothing to redo: recording
     * it would discard that redo at a moment the person did nothing. A fit
     * the host refused waits for the next snapshot, and none is tried while
     * an unresolved structural save stands, which keeps refusing until the
     * person answers it (the window is told that one exists, not which
     * worksheets it restructured, so this holds back more than the host
     * would refuse).
     */
    const try_apply_pending_auto_fit = useCallback(() => {
        if (!pending_auto_fit_sheets_ref.current.has(active_sheet_index)) return;
        if (auto_fit_waits_for_transform(active_sheet_index)) return;
        if (
            save_in_flight_ref.current
            || !edit_gestures_admitted()
            || editing_ref.current?.session_busy() === true
            || structural_save_notice !== null
            || owed_fit_held_ref.current.has(active_sheet_index)
            || peek_history(history_store_ref.current!.snapshot(), 'redo').kind === 'available'
        ) return;
        const outcome = apply_auto_fit_to_active_sheet(true);
        // A posted fit stays owed until the host says it was applied.
        if (outcome === 'unchanged') cancel_pending_auto_fit_for_sheet(active_sheet_index);
    }, [
        active_sheet_index,
        apply_auto_fit_to_active_sheet,
        auto_fit_waits_for_transform,
        cancel_pending_auto_fit_for_sheet,
        edit_gestures_admitted,
        structural_save_notice,
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
        // What an owed fit waits for: a free window (no highlight, view
        // request, or save in flight), no open editor, nothing to redo, and
        // after a refusal the next applied snapshot.
        highlight_request_pending,
        view_request_pending,
        editing_status,
        save_operation,
        redo_available,
        applied_snapshot_count,
        try_apply_pending_auto_fit,
    ]);

    /**
     * The grid's last reason to stay busy has ended (an editor or menu closed
     * without a change): an idle session may go, and a fit owed to this
     * worksheet, which waits for exactly that, may land.
     */
    const handle_grid_idle = useCallback(() => {
        release_edit_session_if_idle();
        try_apply_pending_auto_fit();
        // A gesture that waited for the session has run, or an admission the
        // grid was asked for has finished: a press held behind it asks again.
        wake_history_press();
    }, [release_edit_session_if_idle, try_apply_pending_auto_fit, wake_history_press]);

    const handle_auto_fit_all_sheets = useCallback(() => {
        // Asked first: refused, no sheet is owed a fit.
        if (!size_gesture_may_start()) return;
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
                && apply_auto_fit_to_active_sheet() !== 'nothing-to-measure');
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
        size_gesture_may_start,
        update_pending_auto_fit_sheets,
    ]);

    /** Restore every sheet's pre-fit widths, and drop any fit still owed. */
    const handle_restore_widths_all_sheets = useCallback(() => {
        // Asked first: refused, the fits still owed stay owed.
        if (!size_gesture_may_start()) return;
        const auto_fit_extras_before = auto_fit_extras();
        update_pending_auto_fit_sheets(EMPTY_PENDING_AUTO_FIT);
        restore_widths_for_sheets(
            Array.from({ length: meta?.sheets.length ?? 0 }, (_, index) => index),
            auto_fit_extras_before,
        );
    }, [
        auto_fit_extras,
        meta,
        restore_widths_for_sheets,
        size_gesture_may_start,
        update_pending_auto_fit_sheets,
    ]);

    const current_sheet = meta?.sheets[active_sheet_index];
    // Discarded tombstones a stored Formula Anchor names must survive a
    // structural action: every worksheet's cell edits, and every other
    // worksheet's Pending Rows and Pending Columns. The acting worksheet's own
    // are read by the store from the action's result.
    const formula_anchor_references = useCallback((target: WorksheetTarget) => {
        const registry = edit_session_registry_ref.current!;
        const cells = new Map(registry.entries());
        const pending = new Map(registry.pending_entries());
        return referenced_pending_ids(target, (meta?.sheets ?? []).map((sheet, sheetIndex) => {
            const structure = sheetIndex === target.sheetIndex
                ? undefined
                : pending.get(sheetIndex)?.snapshot();
            return {
                target: {
                    sheetIndex,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                },
                cells: cells.get(sheetIndex)?.snapshot().values() ?? [],
                ...(structure === undefined ? {} : { changes: structure }),
            };
        }));
    }, [meta]);
    const formula_reference_bases = useCallback((
        value: string,
        additional_pending_rows = 0,
    ) =>
        capture_pending_formula_reference_bases(
            value,
            active_sheet_index,
            meta?.sheets ?? [],
            (meta?.sheets ?? []).map((_sheet, index) =>
                edit_session_registry_ref.current!
                    .pending_rows_for_sheet(index)
                    .snapshot()),
            { [active_sheet_index]: additional_pending_rows },
        ), [active_sheet_index, meta]);
    const active_pending_changes = pending_structure.changes_for(active_sheet_index)
        ?? EMPTY_PENDING_STRUCTURAL_CHANGES;
    const active_pending_conflicts = active_pending_changes.conflicts;
    // Merges display unmerged on a worksheet with a layout change, as they do
    // in a transformed view: a removed row inside a merge keeps its place, so
    // the merge's display span no longer means its saved span.
    const active_layout_changed = has_live_layout_change(active_pending_changes);
    // What "Keep new rows at the end" loses, counted for its notice: Pending
    // Columns that hold typed values or formulas.
    const active_column_values_lost = (active_pending_changes.pendingColumns ?? []).filter((column) =>
        Object.values(column.cells).some((cell) => cell.value !== '')).length;
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
    const current_header_row = current_sheet?.excelFirstRowHeader?.sourceRow ?? 0;
    // An unsaved edit names a column only where the worksheet has a header row
    // of cells: with the Header Row on. Anywhere else (a .csv, or the Header
    // Row off) source row 0 is a row of data, and an edit there is not a rename.
    const current_header_row_active = current_sheet?.excelFirstRowHeader?.active === true;
    const current_pending_header_names = Array.from(
        { length: current_sheet?.columnCount ?? 0 },
        (_, index) => current_header_row_active
            ? edit_session_registry_ref.current!
                .for_sheet(active_sheet_index)
                .get(`${current_header_row}:${index}`)?.value.trim()
            : undefined,
    );
    const current_pending_header_signature = JSON.stringify(current_pending_header_names);
    const column_names = useMemo(() => Array.from(
        { length: current_sheet?.columnCount ?? 0 },
        (_, index) => current_pending_header_names[index]
            || current_sheet?.columnNames?.[index]
            || column_letter(index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [current_schema, current_pending_header_signature]);
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
    const handle_saved_row_focus_applied = useCallback((
        sequence: number,
        visible: boolean | null,
    ) => {
        set_saved_row_focus((current) => (
            current?.sequence === sequence ? null : current
        ));
        if (visible === false) {
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'Saved row is hidden by the current filters.',
            });
        }
    }, []);
    const handle_pending_row_focus_applied = useCallback((sequence: number) => {
        set_pending_row_focus((current) => (
            current?.sequence === sequence ? null : current
        ));
    }, []);
    const handle_preview_visible_row_change = useCallback((row: number) => {
        if (preview_mode_ref.current) last_preview_visible_row_ref.current = row;
    }, []);
    const focus_columns_trigger = useCallback(() => {
        toolbar_focus_ref.current?.focus_columns();
    }, []);
    const focus_grid_after_toolbar_action = useCallback(() => {
        grid_focus_ref.current?.focus();
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
    const editing_status_is_for_active_sheet =
        editing_status_sheet_index === active_sheet_index;
    const live_edits = editing_status_is_for_active_sheet
        ? editing_status?.edits
        : undefined;
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
                // claiming "save was cancelled" over it is a lie. Full durable
                // identity is deliberate: value alone misses a re-typed identical
                // value over a new base (genuinely unjudged), base alone misses
                // a corrected value over the same stale base, and the run sides
                // catch a formatting-only replacement.
                const judged = save_rejection.entries[key];
                if (dirty_entries_equal(live, judged)) return true;
                const observed = save_rejection.observed_bases?.[key];
                if (observed === undefined) return false;
                // A host observation is handed to GridShell on the first render
                // after rejection. Until the shell reports the adopted entry back,
                // the live map still has the exact submitted identity above; after
                // adoption it has this enriched identity. Both are the same judged
                // edit. Anything else is a fresh, unsubmitted edit and expires the
                // verdict.
                return dirty_entries_equal(
                    live,
                    dirty_entry_with_observed_file_base(judged, observed),
                );
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
    const live_host_observed_bases = useMemo(() => {
        if (!save_rejection?.observed_bases || live_rejected_keys.length === 0) {
            return undefined;
        }
        const entries = live_rejected_keys.flatMap((key) => {
            const observed = save_rejection.observed_bases?.[key];
            return observed === undefined ? [] : [[key, observed] as const];
        });
        return entries.length === 0 ? undefined : Object.fromEntries(entries);
    }, [live_rejected_keys, save_rejection]);

    // The active worksheet's structural conflict, whose notice counts what
    // each salvage action does to formulas: Discard for either reason, Keep
    // only for a Structural Basis change.
    const impact_conflict = !editing_session_held
        ? undefined
        : active_pending_conflicts.some((conflict) => conflict.reason === 'structuralBasisChanged')
            ? 'structuralBasisChanged'
            : active_pending_conflicts.some((conflict) => conflict.reason === 'unsupportedStructure')
                ? 'unsupportedStructure'
                : undefined;
    // What each salvage action would do to the workbook's formulas, counted
    // by the host before the user chooses.
    const formula_impact_states = useMemo((): {
        readonly before: FormulaImpactState;
        readonly keep?: FormulaImpactState;
        readonly discard: FormulaImpactState;
    } | undefined => {
        if (impact_conflict === undefined || !meta || edit_syntax !== 'markdown'
            || formula_anchor_workbook === undefined) return undefined;
        const sheet = meta.sheets[active_sheet_index];
        if (sheet === undefined) return undefined;
        const { changes_for } = pending_structure;
        const current = changes_for(active_sheet_index) ?? EMPTY_PENDING_STRUCTURAL_CHANGES;
        const context = salvage_context(active_sheet_index);
        if (context === undefined) return undefined;
        const state_for = (override?: PendingStructuralChanges): FormulaImpactState => {
            const changes_with = override === undefined
                ? changes_for
                : (sheet_index: number) => sheet_index === active_sheet_index ? override : changes_for(sheet_index);
            const workbook = override === undefined
                ? formula_anchor_workbook
                : webview_formula_workbook(true, meta.sheets, changes_with);
            const request = prospective_formula_request({
                workbook,
                changes_for: changes_with,
                edits: source_formula_edits,
                pending_edits: formula_roots_projection.pendingEdits,
            });
            return { edits: request.edits, layouts: request.layouts };
        };
        try {
            const discard = discard_layout_changes(current, context);
            if (!discard.ok) return undefined;
            const keep = impact_conflict === 'structuralBasisChanged'
                ? keep_inserted_rows_at_end(current, context, Date.now() * 1_000)
                : undefined;
            return {
                before: state_for(),
                discard: state_for(discard.outcome.next),
                ...(keep?.ok ? { keep: state_for(keep.outcome.next) } : {}),
            };
        } catch {
            return undefined;
        }
    },
        // The edit signature stands in for the source and pending formula edits.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [impact_conflict, formula_calculation_edit_signature, active_sheet_index, meta,
            edit_syntax, pending_structure, formula_anchor_workbook],
    );
    // Each state the actions would act on gets its own key, so counts for an
    // older state never show beside actions that act on a newer one.
    const formula_impact_key_ref = useRef(0);
    const formula_impact_key = useMemo(
        () => formula_impact_states === undefined
            ? undefined
            : `${load_epoch}:${++formula_impact_key_ref.current}`,
        [formula_impact_states, load_epoch],
    );
    const salvage_impact = use_host_question({
        type: 'formulaImpact',
        key: formula_impact_key,
        sourceGeneration: () => source_generation_ref.current,
        ask: (requestId, sourceGeneration) => ({
            type: 'requestFormulaImpact',
            requestId,
            sourceGeneration,
            ...formula_impact_states!,
        }),
        read: (message) => message.impacts,
    });
    // The counts describe what each salvage action does, so the actions wait
    // for the answer to the current request. A host that cannot count
    // answers null, and the actions go ahead without counts.
    const formula_impact_view: PendingChangeFormulaImpact | undefined = formula_impact_key === undefined
        ? undefined
        : !salvage_impact.current
            ? { state: 'pending' }
            : salvage_impact.answer === null || salvage_impact.answer === undefined
                ? { state: 'unavailable' }
                : { state: 'ready', ...salvage_impact.answer };
    const notice_conflicts = editing_session_held ? active_pending_conflicts : EMPTY_CONFLICTS;
    const notice_worksheet_key = !meta
        ? ''
        : worksheet_target_key({
            sheetIndex: active_sheet_index,
            sheetName: meta.sheets[active_sheet_index]?.name ?? '',
            ...(meta.sheets[active_sheet_index]?.worksheetId !== undefined
                ? { worksheetId: meta.sheets[active_sheet_index]!.worksheetId! }
                : {}),
        });
    // Every pending-change notice, in order (ADR 0006); the module decides
    // which show, what they say, and what each action does.
    const notices = useMemo(() => {
        if (!meta) return [];
        const worksheets = meta.sheets.map((sheet, sheet_index): PendingChangeNoticeWorksheet => {
            const pending_columns = pending_structure.changes_for(sheet_index)?.pendingColumns ?? [];
            const pending_names = new Map(pending_columns.map((column) => [column.id, column.header]));
            const header = sheet.excelFirstRowHeader;
            const columns = formula_anchor_workbook?.worksheets[sheet_index]?.columns;
            // The names the grid shows over each column, a rename included.
            const cells = pending_cells.cells_for(sheet_index);
            const shown_name = (source_column: number): string | undefined => {
                const entry = cells.get(`${header?.sourceRow ?? 0}:${source_column}`);
                return entry === undefined
                    ? sheet.columnNames?.[source_column]
                    : committed_column_name(entry.value);
            };
            const prospective = header?.active === true && columns !== undefined
                ? Array.from({ length: columns.liveCount }, (_, column) => {
                    const identity = columns.identity_at(column + 1);
                    return identity === undefined
                        ? undefined
                        : identity.kind === 'source'
                            ? shown_name(identity.sourceColumn)
                            : pending_names.get(identity.pendingColumnId);
                })
                : undefined;
            return {
                name: sheet.name,
                ...(header?.active === true && sheet.columnNames !== undefined
                    ? { columnNames: sheet.columnNames }
                    : {}),
                ...(pending_names.size > 0 ? { pendingColumnNames: pending_names } : {}),
                ...(prospective === undefined ? {} : { prospectiveColumnNames: prospective }),
            };
        });
        return pending_change_notices({
            singleTable: edit_syntax !== 'markdown',
            activeSheetIndex: active_sheet_index,
            worksheets,
            conflicts: {
                worksheetKey: notice_worksheet_key,
                items: notice_conflicts,
                columnValuesLost: active_column_values_lost,
                ...(formula_impact_view === undefined ? {} : { impact: formula_impact_view }),
            },
            refusals: rule_split_warning_messages,
            ...(formula_review_key !== undefined && formula_review.answer !== undefined
                ? { formulaReview: { review: formula_review.answer, current: formula_review.current } }
                : {}),
            dismissed: dismissed_notices,
        });
    },
        // The impact answer and key stand in for `formula_impact_view`, rebuilt every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [meta, edit_syntax, active_sheet_index, notice_worksheet_key, notice_conflicts, active_column_values_lost,
            salvage_impact.answer, salvage_impact.current, formula_impact_key, rule_split_warning_messages,
            formula_review_key, formula_review.answer, formula_review.current, dismissed_notices,
            pending_structure, pending_cells, formula_anchor_workbook],
    );
    if (!meta) {
        return compare_progress
            ? (
                <CompareProgress
                    scannedRows={compare_progress.scannedRows}
                    totalRows={compare_progress.totalRows}
                    on_cancel={handle_cancel_compare}
                />
            )
            : <div className="loading">Loading...</div>;
    }

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = meta.sheets.map((s) => s.name);
    // Git compare badges: mark sheets that exist on only one side. The host
    // states each grid sheet's pair status positionally (sheetStatuses), so
    // nothing here re-derives the compare source's sheet ordering.
    const sheet_badges: (SheetTabBadge | undefined)[] | undefined =
        git_compare?.sheetStatuses.map((status) =>
            status === 'matched' ? undefined : status);
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
                    disabled: pending_excel_header !== null
                        || header_fence
                        || excel_header_queue !== null
                        || pending_transforms.some(Boolean)
                        || header_capable_sheets.every((sheet) =>
                            sheet.excelFirstRowHeader!.mode === 'on'
                            || sheet.excelFirstRowHeader!.active),
                    on_click: () => set_excel_header_all_sheets(true),
                },
                {
                    label: `Show first row as data on ${all_sheets}`,
                    disabled: pending_excel_header !== null
                        || header_fence
                        || excel_header_queue !== null
                        || pending_transforms.some(Boolean)
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
    // An editing session, separately, suppresses nothing: an installed sort or
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
        && (transform_active || has_hidden_columns || active_layout_changed);
    const transform_pending = pending_transforms[active_sheet_index] ?? false;
    const hidden_row_count = visible_transform.hiddenRows?.length ?? 0;
    const show_formatting = show_formatting_by_sheet[active_sheet_index] ?? true;
    const excel_header = current_sheet.excelFirstRowHeader;
    const excel_header_candidate_available = current_sheet.columnCount > 0
        && hidden_row_count < current_sheet.sourceRowCount;
    const excel_header_pending = pending_excel_header !== null;
    // A Header Row change works under unsaved changes: the host moves the
    // session's Pending Changes to the new header in the same write, and the
    // header queue makes sure it holds all of them first. Only a header change
    // or a transform already in flight holds the controls back.
    const excel_header_change_pending = excel_header_pending
        || header_fence
        || excel_header_queue !== null;
    const excel_header_disabled = !!excel_header && (
        (!excel_header_candidate_available
            && !excel_header.active
            && excel_header.mode !== 'on')
        || any_transform_pending
        || excel_header_change_pending
    );
    // A transform in flight only disables promotion (see the prop below).
    const promote_row_blocked = !!excel_header && excel_header_change_pending;
    // While this sheet's sort, filter, or Hide rows is in flight, the menus
    // offer items by the rules it will install, so nothing appears or vanishes
    // under the pointer when it lands. Hide rows requests no rules: those on
    // screen stay.
    const pending_transform_target = transform_pending && !preview_mode
        ? pending_transform_states_ref.current[active_sheet_index] ?? visible_transform
        : undefined;
    // The rules asked for, which every sort and filter control shows and builds
    // from (I6), and whether those controls wait: only for a hide, a replay, or
    // a restore on the sheet, never for the person's own request, which a new
    // choice replaces.
    const requested_transform = pending_transform_target ?? visible_transform;
    const transform_choice_pending = transform_pending && view_choice_waits(active_sheet_index);
    const excel_header_disabled_reason = !excel_header_candidate_available
        && !excel_header?.active
        ? 'This sheet has no first row to use as column names.'
        : excel_header_queue?.replay !== undefined
        ? `${excel_header_queue.replay === 'undo' ? 'Undoing' : 'Redoing'} a header row change…`
        : excel_header_pending
        ? pending_excel_header_unhide_ref.current
            ? 'Restoring rows…'
            : pending_excel_header_promote_ref.current
            ? 'Making row header…'
            : 'Updating column names…'
        : header_fence
        ? 'Saving your changes before changing the header row…'
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
     * The editing session is deliberately absent — sorting and filtering stay available
     * while editing. What remains are the windows in which the host would refuse
     * the request anyway (a save in flight, a claim mid-flight) or in which the
     * displayed order is not the user's to change (preview, an Excel header
     * change reshaping the rows underneath).
     */
    // The save term is read from the authoritative workbook lifecycle, not only
    // from the mounted grid's report. The lifecycle is document-scoped, so these
    // controls must remain fenced when any worksheet participates in the save,
    // including a sibling-only operation the current grid does not hydrate.
    // A retained local proposal remains authoritative for the document fence even
    // after a mismatched newer terminal advances the host lifecycle. These controls
    // must name that proposal as well as the usual active/status signals or they can
    // admit exit and transform requests while the save is still locked.
    const save_ui_fenced = save_operation !== undefined
        || save_lifecycle.state === 'active'
        || editing_status?.save_in_flight === true;
    // Unsaved work, on any worksheet or still in an open editor: what Save
    // would write and Discard would drop.
    const is_dirty = edit_session_registry_ref.current!.has_dirty_entries()
        || editing_status?.has_live_uncommitted === true;
    const transform_ui_blocked =
        save_ui_fenced
        || edit_session_pending
        || preview_mode
        || excel_header_pending;
    // Transforms held back by nothing but a session claim in flight. A context
    // menu makes one as it opens, so it shows its transform items disabled
    // through the claim rather than dropping them under the pointer.
    const transform_waits_for_claim = edit_session_pending
        && !save_ui_fenced
        && !preview_mode
        && !excel_header_pending;

    // Stale-view banner: derived from the rules actually *installed* in the grid, not
    // the requested ones, because the statement is about the order the user is
    // looking at. Only meaningful while the session is held — outside it the order
    // recomputes as normal.
    //
    // The hidden cells ride the same record, so they need no state of their own and
    // cannot disagree with the rules they were computed against. No
    // `editing_session_held` term of their own either: the signature below carries
    // the only one there should be, and the message is rendered only when the banner
    // is. Probed rather than assumed
    // — a second copy of that gate here fails no test, which makes it a guard nothing
    // could hold to account. The one below is now pinned: see "goes silent when the
    // session ends with the dirty map still reported", which deleting it fails.
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
    const stale_view_current_signature = editing_session_held
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
    // the second are pluralized as one phrase, as in the file-change notice, so
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

    const externally_changed_keys = editing_status_is_for_active_sheet
        ? editing_status?.conflicted ?? []
        : [];
    const show_host_rejection = editing_session_held
        && live_rejected_keys.length > 0;
    const removed_keys = show_host_rejection
        && save_rejection?.reason === 'rowsRemoved'
        ? live_rejected_keys.filter((key) => (
            save_rejection.removed_keys ?? save_rejection.keys
        ).includes(key))
        : [];
    const removed_key_set = new Set(removed_keys);
    const changed_key_set = new Set([...externally_changed_keys, ...live_rejected_keys]);
    const changed_items = [...changed_key_set]
        .filter((key) => !removed_key_set.has(key))
        .flatMap((key) => {
            const entry = live_edits?.[key];
            if (!entry) return [];
            const observed = entry.observedBase ?? live_host_observed_bases?.[key];
            return [{ key, entry, observed }];
        });
    const removed_items = removed_keys.flatMap((key) => {
        const entry = live_edits?.[key];
        return entry ? [{ key, entry }] : [];
    });
    const external_change_location = (key: string): string => {
        const coordinates = parse_cell_key(key);
        if (!coordinates) return key;
        const column = column_letter(coordinates.sourceColumn);
        const name = current_sheet.columnNames?.[coordinates.sourceColumn];
        const sheet = current_sheet.name ? `${current_sheet.name}, ` : '';
        return `${sheet}row ${coordinates.sourceRow + 1}, column ${column}${
            name ? ` (${name})` : ''
        }`;
    };
    const removed_rows = rejected_rows(removed_keys);
    const external_change_item_count = changed_items.length + removed_items.length;
    const external_change_is_active = external_change_item_count > 0;
    const external_change_worksheet_key = worksheet_target_key({
        sheetIndex: active_sheet_index,
        sheetName: current_sheet.name,
        ...(current_sheet.worksheetId !== undefined
            ? { worksheetId: current_sheet.worksheetId }
            : {}),
    });
    const previous_external_change = external_change_occurrences_ref.current.get(
        external_change_worksheet_key,
    ) ?? {
        active: false,
        occurrence: 0,
        observations: new Map<string, string>(),
        observedBases: new Map<string, CsvObservedFileBase>(),
        priorObservedBases: new Map<string, CsvObservedFileBase>(),
    };
    let external_change_occurrence = previous_external_change.occurrence;
    let prior_external_change_observed_bases =
        previous_external_change.priorObservedBases;
    if (editing_status_is_for_active_sheet) {
        const observations = new Map<string, string>([
            ...changed_items.map(({ key, observed }) => [
                `changed:${key}`,
                external_change_observation_signature(observed),
            ] as const),
            ...removed_items.map(({ key }) => [`removed:${key}`, 'removed'] as const),
        ]);
        const has_new_observation = [...observations].some(([key, value]) => (
            previous_external_change.observations.get(key) !== value
        ));
        if (
            external_change_is_active
            && (!previous_external_change.active || has_new_observation)
        ) {
            external_change_occurrence += 1;
        }
        const observed_bases = new Map<string, CsvObservedFileBase>();
        const prior_observed_bases = new Map<string, CsvObservedFileBase>();
        for (const { key, observed } of changed_items) {
            if (observed !== undefined) observed_bases.set(key, observed);
            const observation_key = `changed:${key}`;
            if (
                previous_external_change.observations.get(observation_key)
                === observations.get(observation_key)
            ) {
                const retained = previous_external_change.priorObservedBases.get(key);
                if (retained !== undefined) prior_observed_bases.set(key, retained);
            } else {
                const prior = previous_external_change.observedBases.get(key);
                if (prior !== undefined) prior_observed_bases.set(key, prior);
            }
        }
        prior_external_change_observed_bases = prior_observed_bases;
        external_change_occurrences_ref.current.set(external_change_worksheet_key, {
            active: external_change_is_active,
            occurrence: external_change_occurrence,
            observations,
            observedBases: observed_bases,
            priorObservedBases: prior_observed_bases,
        });
    }
    const external_change_occurrence_key = JSON.stringify([
        external_change_worksheet_key,
        external_change_occurrence,
    ]);
    const review_external_changes = external_change_is_active
        && open_external_change_occurrence === external_change_occurrence_key;
    const external_change_navigation_pending_for_review =
        external_change_navigation_pending_key?.startsWith(
            `${external_change_occurrence_key}\u0000`,
        ) === true;
    const show_external_change_banner = editing_session_held
        && (changed_items.length > 0 || removed_items.length > 0)
        && dismissed_external_change_occurrences[external_change_worksheet_key]
            !== external_change_occurrence;
    const external_change_message = [
        show_host_rejection
            ? 'The file changed before it could be saved.'
            : 'The file changed.',
        ...(changed_items.length > 0
            ? [changed_items.length === 1
                ? '1 cell with a pending edit also changed.'
                : `${changed_items.length} cells with pending edits also changed.`]
            : []),
        ...(removed_rows.length > 0
            ? [removed_rows.length === 1
                ? '1 row with pending edits is no longer in the file.'
                : `${removed_rows.length} rows with pending edits are no longer in the file.`]
            : []),
    ].join(' ');
    const external_change_formatting_budget = {
        remaining: EXTERNAL_CHANGE_FORMATTING_COMPARISON_BUDGET,
    };
    const external_change_pending_value = (entry: CsvDirtyEntry): string => (
        xlsx_edit_writes_formula(entry.value, entry.valueRuns?.runs)
            ? formula_move_retargeter(
                entry.value,
                active_sheet_index,
                entry.valueEditOrder ?? 0,
            )
            : entry.value
    );
    const external_change_discard_counts = dirty_move_component_sizes(
        Object.entries(live_edits ?? {}),
    );
    const external_change_discard_label = (key: string): string => {
        const count = external_change_discard_counts.get(key) ?? 1;
        return count > 1
            ? `Discard all pending edits in ${count} related cells`
            : 'Discard my pending edit';
    };

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
    const active_scroll_position_key = worksheet_target_key({
        sheetIndex: active_sheet_index,
        sheetName: current_sheet.name,
        worksheetId: current_sheet.worksheetId,
    });
    const held_composer_draft = append_composer_drafts_ref.current.get(
        active_scroll_position_key,
    );
    const active_composer_draft = held_composer_draft !== undefined
        && held_composer_draft.sessionId === csv_edit_session_id
        && held_composer_draft.schema === current_schema
        ? held_composer_draft.draft
        : EMPTY_APPEND_COMPOSER_DRAFT;
    const handle_append_composer_draft_change = (draft: AppendComposerDraft) => {
        if (csv_edit_session_id === undefined) return;
        append_composer_drafts_ref.current.set(active_scroll_position_key, {
            sessionId: csv_edit_session_id,
            schema: current_schema,
            draft,
        });
        set_append_composer_draft_revision((revision) => revision + 1);
    };

    const grid = (
        <GridShell
            key={`${active_sheet_index}:${current_sheet.worksheetId ?? current_sheet.name}:${load_epoch}:${grid_mount_epoch}`}
            sheet_meta={current_sheet}
            sheet_index={active_sheet_index}
            pending_formula_impact={formula_impact.forSheet(active_sheet_index)}
            formula_results={active_formula_results}
            source_formula_results={active_source_formula_results}
            formula_move_retargeter={formula_move_retargeter}
            formula_reference_bases={formula_reference_bases}
            formula_anchor_workbook={formula_anchor_workbook}
            formula_anchor_references={formula_anchor_references}
            formula_results_prospective={prospective_formula_state !== undefined}
            generation={generation}
            source_generation={source_generation_ref.current}
            row_count={effective_row_count}
            show_formatting={show_formatting}
            auto_fit_active={auto_fit_active[active_sheet_index] ?? false}
            column_projection={current_column_projection}
            // Read from the ref during render, which is sound because every writer
            // of it also moves `generation` — the state this component re-renders
            // on and the grid is keyed by — in the same message handler.
            mapping_generation={mapping_generations_ref.current[active_sheet_index] ?? 1}
            history_focus={history_focus}
            on_history_focus_applied={handle_history_focus_applied}
            saved_row_focus={saved_row_focus}
            on_saved_row_focus_applied={handle_saved_row_focus_applied}
            pending_row_focus={pending_row_focus}
            on_pending_row_focus_applied={handle_pending_row_focus_applied}
            cell_focus={cell_focus}
            on_cell_focus_applied={handle_cell_focus_applied}
            column_widths={column_widths[active_sheet_index] ?? {}}
            on_columns_resized={handle_columns_resized}
            size_gesture_may_start={size_gesture_may_start}
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
            editing_session_held={editing_session_held}
            // Present exactly while an editing gesture should be accepted with
            // no session behind it yet: the file can be edited, and nothing
            // known here would make the host refuse for good.
            on_request_edit_session={
                csv_editing_supported
                && !editing_session_held
                && !save_ui_fenced
                && !(truncation_message && !csv_editable)
                    ? request_edit_session
                    : undefined
            }
            on_edit_session_idle={handle_grid_idle}
            diff_mode={diff_mode}
            git_compare={git_compare !== undefined}
            compare_changed_column_names={
                git_compare?.changedColumnNames[active_sheet_index]
            }
            edit_activation_id={edit_activation_id}
            highlight_in_flight={highlight_request_pending}
            view_request_in_flight={view_request_pending}
            edits_paused={header_fence || reopen_required}
            on_edit_paused_gesture={warn_edit_paused}
            on_save_paused={warn_save_paused}
            append_in_flight={append_request_pending}
            csv_editable={csv_editable}
            append_row_ceiling={append_row_ceiling}
            structural_support={structural_editing?.sheets[active_sheet_index]}
            edit_syntax={edit_syntax}
            edit_session_id={csv_edit_session_id}
            value_edit_order_floor={value_edit_order_floor}
            // Save lifecycle is workbook-scoped so it fences every grid; edit
            // stores remain worksheet-scoped so cell keys never cross sheets.
            save_operation={save_operation}
            save_lifecycle={save_lifecycle}
            on_save_request={begin_save_operation}
            edit_session={edit_session_registry_ref.current!.for_sheet(
                active_sheet_index,
            )}
            pending_row_store={edit_session_registry_ref.current!.pending_rows_for_sheet(
                active_sheet_index,
            )}
            append_composer_draft={active_composer_draft}
            on_append_composer_draft_change={handle_append_composer_draft_change}
            on_append_rows={request_append_rows}
            on_insert_rows={request_structural_insert}
            on_insert_columns={request_structural_column_insert}
            history_store={history_store_ref.current!}
            gestures_admitted={edit_gestures_admitted}
            history_press_held={history_press_held}
            on_history_hold_gesture={say_history_hold_gesture}
            gesture_ticket={gesture_ticket}
            with_gesture_ticket={with_gesture_ticket}
            on_held_typing_end={wake_history_press}
            on_gesture_unrecorded={drop_press_for_unrecorded_gesture}
            host_rejected_keys={live_rejected_keys}
            host_observed_bases={live_host_observed_bases}
            on_editing_change={handle_editing_change}
            editing_ref={editing_ref}
            auto_fit_ref={auto_fit_ref}
            pending_auto_fit_ref={pending_auto_fit_ref}
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
            initial_scroll_position={
                grid_scroll_positions_ref.current.get(active_scroll_position_key)
            }
            on_scroll_position_change={(position) => {
                grid_scroll_positions_ref.current.set(active_scroll_position_key, position);
            }}
            transform_state={visible_transform}
            transform_sections={!transform_ui_blocked}
            transform_waits_for_claim={transform_waits_for_claim}
            transform_pending={transform_pending}
            transform_choice_pending={transform_choice_pending}
            {...(pending_transform_target === undefined ? {} : { pending_transform_target })}
            on_transform_change={handle_grid_transform_change}
            on_open_filter={open_grid_filter_editor}
            on_hide_column={handle_toggle_column}
            on_hide_columns={handle_hide_columns}
            on_hide_rows={handle_hide_rows}
            can_promote_row_to_header={
                excel_header !== undefined && !promote_row_blocked && !preview_mode
                    // In flight here, GridShell asks the rules it will install.
                    && (transform_pending
                        || !header_waits_for_transform(active_sheet_index, true, false))
            }
            promote_row_to_header_waits={any_transform_pending}
            on_promote_row_to_header={handle_promote_row_to_header}
            on_focus_columns={focus_columns_trigger}
            cell_highlights={cell_highlights?.sheets[active_sheet_index]}
            on_highlight_selection={handle_highlight_selection}
            on_highlight_selection_available_change={set_highlight_selection_available}
            highlight_ref={highlight_ref}
        />
    );

    // What the comparison found, and the filter that acts on it. Workbook state —
    // the totals span every sheet — so it sits above the tabs, unlike StateStrip.
    const compare_strip = git_compare
        ? (
            <CompareStrip
                {...(git_compare.sides ? { sides: git_compare.sides } : {})}
                counts={git_compare.counts}
                degraded={git_compare.degraded}
                move_search_truncated={git_compare.moveSearchTruncated}
                other_differences={
                    git_compare.changedColumnNames.some((columns) => columns.length > 0)
                    || git_compare.sheetStatuses.some((status) => status !== 'matched')
                }
                only_changed_rows={requested_transform.onlyChangedRows === true}
                on_toggle_only_changed_rows={handle_toggle_only_changed_rows}
                filter_pending={transform_choice_pending}
            />
        )
        : null;

    // Sort, filter, row hiding and the merge notice — worksheet state, so it sits
    // with the worksheet's pane below the tabs rather than in the workbook chrome
    // above them (#154). Renders nothing when the view is untransformed.
    const handle_notice_intent = (intent: PendingChangeNoticeIntent): void => {
        switch (intent.kind) {
            case 'goToCell':
                go_to_prospective_cell(intent.sheetIndex, intent.row, intent.column);
                return;
            case 'dismiss':
                set_dismissed_notices((current) => new Set([...current, intent.key]));
                queueMicrotask(() => grid_focus_ref.current?.focus());
                return;
            case 'keepInsertedRowsAtEnd':
                keep_active_inserted_rows_at_end();
                return;
            case 'discardLayoutChanges':
                discard_active_layout_changes();
                return;
            case 'retryFormulaImpact':
                salvage_impact.retry();
                return;
            case 'goToAffectedRow': {
                const target = intent.target;
                if (target.kind === 'pendingRow') editing_ref.current?.reveal_pending_row(target.pendingRowId);
                else if (target.kind === 'tailRemoval') editing_ref.current?.reveal_tail_removal(target.tailRemovalId);
                else void editing_ref.current?.reveal_source_cell(target.sourceRow, target.sourceColumn);
                return;
            }
            case 'removePendingRows':
                if (refused_for_reopen()) return;
                editing_ref.current?.remove_pending_rows(intent.pendingRowIds);
                return;
            case 'cancelTailRemovals':
                if (refused_for_reopen()) return;
                editing_ref.current?.cancel_tail_removals(intent.tailRemovalIds);
                return;
        }
    };

    const sheet_pane = (
        <div className="sheet-pane">
            <StateStrip
                transform={requested_transform}
                transform_disabled={transform_ui_blocked}
                transform_pending={transform_pending}
                transform_choice_pending={transform_choice_pending}
                transform_progress={pending_transform_labels[active_sheet_index]}
                hidden_rows={{
                    count: hidden_row_count,
                    pending: transform_choice_pending,
                    // For a promoted header it is a Header Row change, so it
                    // waits like one; see `excel_header_change_pending`.
                    disabled: excel_header_change_pending
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
            {notices.length > 0 && (
                // Docked under the grid rather than above it, so a notice that
                // appears or goes after a gesture never moves the row under
                // the pointer.
                <PendingChangeNotices
                    notices={notices}
                    status={pending_change_notice_status}
                    on_intent={handle_notice_intent}
                />
            )}
            {find_open && (
                <FindBar
                    ref={find_bar_ref}
                    query={find_query}
                    status={find_status}
                    on_query_change={(query) => {
                        set_find_query(query);
                        run_find(query, 1, true);
                    }}
                    on_next={() => run_find(find_query, 1, false)}
                    on_previous={() => run_find(find_query, -1, false)}
                    on_close={close_find}
                />
            )}
        </div>
    );

    return (
        <div className={`viewer ${effective_vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                ref={toolbar_focus_ref}
                on_action_complete={focus_grid_after_toolbar_action}
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
                editable={csv_editing_supported}
                diff_mode={diff_mode}
                on_toggle_diff_mode={handle_toggle_diff_mode}
                is_dirty={is_dirty}
                save_description={save_description}
                on_save={handle_save}
                on_discard={discard_edit_session}
                save_busy={save_ui_fenced}
            />
            {filter_editor && (
                <FilterPopover
                    // Not keyed by the source generation: a reload that keeps
                    // the columns keeps the editor, and its draft with it.
                    key={`${active_sheet_index}:${filter_editor.column_index}`}
                    column_index={filter_editor.column_index}
                    column_name={column_names[filter_editor.column_index]
                        ?? `Column ${filter_editor.column_index + 1}`}
                    filters={requested_transform.filters}
                    anchor={filter_editor.anchor}
                    histogram={filter_histogram.key === `${source_generation_ref.current}:${active_sheet_index}:${filter_editor.column_index}`
                        ? filter_histogram.value
                        : { status: 'loading' }}
                    show_formatting={show_formatting}
                    on_apply={apply_filter_editor}
                    on_cancel={(reason) => close_filter_editor(
                        reason === 'escape' || reason === 'explicit',
                    )}
                    on_remove={remove_filter_editor}
                />
            )}
            {unresolved_lfs && (
                // Above the truncation banner: an unfetched object is the more
                // fundamental fact — there is no data at all on that side — and
                // in the `file` case a row cap on an empty grid is moot anyway.
                <LfsBanner
                    unresolved={unresolved_lfs}
                    resolving={lfs_resolving}
                    on_resolve={() => {
                        // Synchronous fence: React disables the button on the
                        // next render, but a double-click lands before it.
                        if (pending_lfs_resolve_request_ref.current !== null) return;
                        lfs_resolve_request_seq_ref.current += 1;
                        const request_id = [
                            'lfs',
                            lfs_resolve_request_prefix_ref.current,
                            lfs_resolve_request_seq_ref.current,
                        ].join(':');
                        pending_lfs_resolve_request_ref.current = request_id;
                        set_lfs_resolving(true);
                        host_bridge.postMessage({
                            type: 'resolveLfsObject',
                            requestId: request_id,
                        });
                    }}
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
            {structural_save_notice !== null && (
                // The host could not tell whether the last structural save of
                // this file finished. Editing is refused and the restructured
                // worksheets render without source-keyed highlights, hidden rows,
                // and widths until the user answers; the default action is the
                // host's hint from the file's row and column counts.
                <div className="external-change-banner structural-save-notice" role="alert">
                    {structural_save_notice.message}
                    {structural_save_notice.suggestion === 'finished'
                        ? " The file's shape matches the saved changes."
                        : ''}
                    <div className="external-change-banner-actions">
                        {(['finished', 'notFinished'] as const).map((choice) => (
                            <button
                                key={choice}
                                autoFocus={structural_save_notice.suggestion === choice}
                                className={structural_save_notice.suggestion === choice ? 'primary' : undefined}
                                onClick={() => {
                                    host_bridge.postMessage({
                                        type: 'resolveStructuralSave',
                                        saveId: structural_save_notice.saveId,
                                        choice,
                                    });
                                }}
                            >
                                {choice === 'finished' ? 'It finished' : "It didn't finish"}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {show_external_change_banner && (
                <div className="external-change-banner" role="status">
                    {external_change_message}
                    <div className="external-change-banner-actions">
                        <button
                            ref={external_change_review_button_ref}
                            aria-expanded={review_external_changes}
                            aria-controls="external-change-review"
                            onClick={() => {
                                cancel_external_change_navigation();
                                set_open_external_change_occurrence(
                                    external_change_occurrence_key,
                                );
                                set_external_change_navigation_status('');
                            }}
                        >
                            Review changes
                        </button>
                        <button
                            onClick={() => {
                                grid_focus_ref.current?.focus();
                                cancel_external_change_navigation();
                                set_dismissed_external_change_occurrences((current) => ({
                                    ...current,
                                    [external_change_worksheet_key]: external_change_occurrence,
                                }));
                                set_open_external_change_occurrence(null);
                                set_external_change_navigation_status('');
                            }}
                            aria-label="Dismiss file-change notice"
                        >
                            Dismiss
                        </button>
                    </div>
                </div>
            )}
            {review_external_changes
                && (changed_items.length > 0 || removed_items.length > 0) && (
                <section
                    key={external_change_occurrence_key}
                    id="external-change-review"
                    ref={mount_external_change_review}
                    data-navigation-context={external_change_occurrence_key}
                    tabIndex={-1}
                    className="external-change-review"
                    aria-label="File changes affecting pending edits"
                >
                    <div className="external-change-review-header">
                        <h2>File changes affecting pending edits</h2>
                        <button onClick={() => {
                            external_change_review_button_ref.current?.focus();
                            cancel_external_change_navigation();
                            set_open_external_change_occurrence(null);
                        }}>
                            Close
                        </button>
                    </div>
                    <ul className="external-change-list">
                        {changed_items.map(({ key, entry, observed }) => {
                            const coordinates = parse_cell_key(key);
                            const location = external_change_location(key);
                            const discard_label = external_change_discard_label(key);
                            const value_pending = dirty_entry_value_dimension_present(entry);
                            const original_formatting_is_known =
                                !dirty_entry_base_formatting_unknown(entry);
                            const prior_observed =
                                prior_external_change_observed_bases.get(key);
                            const formatting_baseline = original_formatting_is_known
                                ? {
                                    label: 'Original file formatting',
                                    value: entry.base,
                                    runs: entry.baseRuns,
                                }
                                : prior_observed !== undefined
                                    ? {
                                        label: 'Previous file formatting',
                                        value: prior_observed.value,
                                        runs: prior_observed.runs,
                                    }
                                    : undefined;
                            const formatting_changed = formatting_baseline !== undefined
                                && observed !== undefined
                                && review_formatting_changed(
                                    formatting_baseline.value,
                                    formatting_baseline.runs,
                                    observed.value,
                                    observed.runs,
                                    external_change_formatting_budget,
                                );
                            const link_changed = entry.link !== undefined
                                && observed?.link !== undefined
                                && !hyperlinks_equal(entry.baseLink ?? null, observed.link);
                            const pending_formatting_involved = value_pending && (
                                original_formatting_is_known
                                    ? review_formatting_changed(
                                        entry.base,
                                        entry.baseRuns,
                                        entry.value,
                                        entry.valueRuns,
                                        external_change_formatting_budget,
                                    )
                                    : entry.valueRuns !== undefined
                                        && [entry.valueRuns, observed?.runs].some((runs) => (
                                            runs !== undefined && rich_text_has_styles(runs)
                                        ))
                            );
                            const show_formatting_values = formatting_changed
                                || pending_formatting_involved;
                            const can_navigate = coordinates !== undefined
                                && editing_ref.current?.can_reveal_source_cell(
                                    coordinates.sourceRow,
                                    coordinates.sourceColumn,
                                ) === true;
                            const navigation_key = [
                                external_change_occurrence_key,
                                key,
                            ].join('\u0000');
                            return (
                                <ExternalChangeItem
                                    key={key}
                                    source_key={key}
                                    on_detach={handle_external_change_item_detach}
                                >
                                    <h3>{location}</h3>
                                    {observed ? (
                                        <div className="external-change-values">
                                            <div className="external-change-value-row">
                                                <span>Original file value</span>
                                                <code>{review_value(entry.base)}</code>
                                            </div>
                                            <div className="external-change-value-row">
                                                <span>Current file value</span>
                                                <code>{review_value(observed.value)}</code>
                                            </div>
                                            {formatting_changed && (
                                                <div className="external-change-detail">
                                                    {original_formatting_is_known
                                                        ? 'Cell formatting also changed in the file.'
                                                        : 'Cell formatting changed again in the file.'}
                                                </div>
                                            )}
                                            {link_changed && observed.link !== undefined && (
                                                <>
                                                    <div className="external-change-value-row">
                                                        <span>Original file link</span>
                                                        <code>{review_link(entry.baseLink ?? null)}</code>
                                                    </div>
                                                    <div className="external-change-value-row">
                                                        <span>Current file link</span>
                                                        <code>{review_link(observed.link)}</code>
                                                    </div>
                                                </>
                                            )}
                                            {show_formatting_values && (
                                                <>
                                                    {formatting_baseline !== undefined && (
                                                        <div className="external-change-value-row">
                                                            <span>{formatting_baseline.label}</span>
                                                            <code>{review_formatting(
                                                                formatting_baseline.value,
                                                                formatting_baseline.runs,
                                                            )}</code>
                                                        </div>
                                                    )}
                                                    <div className="external-change-value-row">
                                                        <span>Current file formatting</span>
                                                        <code>{review_formatting(
                                                            observed.value,
                                                            observed.runs,
                                                        )}</code>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="external-change-values">
                                            <div className="external-change-value-row">
                                                <span>Original file value</span>
                                                <code>{review_value(entry.base)}</code>
                                            </div>
                                            <div className="external-change-value-row">
                                                <span>Current file value</span>
                                                <code>(unavailable)</code>
                                            </div>
                                            {show_formatting_values && (
                                                <>
                                                    {formatting_baseline !== undefined && (
                                                        <div className="external-change-value-row">
                                                            <span>{formatting_baseline.label}</span>
                                                            <code>{review_formatting(
                                                                formatting_baseline.value,
                                                                formatting_baseline.runs,
                                                            )}</code>
                                                        </div>
                                                    )}
                                                    <div className="external-change-value-row">
                                                        <span>Current file formatting</span>
                                                        <code>(unavailable)</code>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    )}
                                    <div className="external-change-pending">
                                        {value_pending && (
                                            <>
                                                <span>Your pending edit</span>
                                                <code>{review_value(
                                                    external_change_pending_value(entry)
                                                )}</code>
                                            </>
                                        )}
                                        {pending_formatting_involved && (
                                            <>
                                                <span>Your pending formatting</span>
                                                <code>{review_formatting(
                                                    entry.value,
                                                    entry.valueRuns,
                                                )}</code>
                                            </>
                                        )}
                                        {entry.link !== undefined && (
                                            <>
                                                <span>Your pending link</span>
                                                <code>{review_link(entry.link)}</code>
                                            </>
                                        )}
                                    </div>
                                    <div className="external-change-item-actions">
                                        {can_navigate && (
                                            <button
                                                onClick={async () => {
                                                    if (!coordinates) return;
                                                    const request_id =
                                                        ++external_change_navigation_request_ref.current;
                                                    set_external_change_navigation_pending_key(
                                                        navigation_key,
                                                    );
                                                    external_change_navigation_pending_ref.current =
                                                        navigation_key;
                                                    const is_current = () => (
                                                        external_change_navigation_request_ref.current
                                                            === request_id
                                                        && external_change_navigation_context_ref.current
                                                            === external_change_occurrence_key
                                                    );
                                                    const shown = await editing_ref.current
                                                        ?.reveal_source_cell(
                                                            coordinates.sourceRow,
                                                            coordinates.sourceColumn,
                                                            is_current,
                                                        );
                                                    if (!is_current()) return;
                                                    external_change_navigation_pending_ref.current = null;
                                                    set_external_change_navigation_pending_key(null);
                                                    set_external_change_navigation_status(shown
                                                        ? ''
                                                        : 'That cell is not available in the current view.');
                                                }}
                                                aria-label={`Go to ${location}`}
                                                aria-busy={
                                                    external_change_navigation_pending_key
                                                        === navigation_key
                                                }
                                                disabled={
                                                    external_change_navigation_pending_for_review
                                                }
                                            >
                                                {external_change_navigation_pending_key
                                                    === navigation_key
                                                    ? 'Going…'
                                                    : 'Go to cell'}
                                            </button>
                                        )}
                                        <button
                                            onClick={() => {
                                                // Writes this window's store, which
                                                // a window that must be reopened
                                                // no longer sends to the file.
                                                if (refused_for_reopen()) return;
                                                cancel_external_change_navigation();
                                                if (external_change_item_count === 1) {
                                                    grid_focus_ref.current?.focus();
                                                } else {
                                                    external_change_review_ref.current?.focus();
                                                }
                                                editing_ref.current?.discard_keys([key]);
                                                set_external_change_navigation_status('');
                                            }}
                                            aria-label={discard_label + ' for ' + location}
                                        >
                                            {discard_label}
                                        </button>
                                    </div>
                                </ExternalChangeItem>
                            );
                        })}
                        {removed_items.map(({ key, entry }) => {
                            const location = external_change_location(key);
                            const discard_label = external_change_discard_label(key);
                            const value_pending = dirty_entry_value_dimension_present(entry);
                            const original_formatting_is_known =
                                !dirty_entry_base_formatting_unknown(entry);
                            const formatting_involved = original_formatting_is_known
                                && value_pending
                                && review_formatting_changed(
                                    entry.base,
                                    entry.baseRuns,
                                    entry.value,
                                    entry.valueRuns,
                                    external_change_formatting_budget,
                                );
                            const pending_formatting_involved = value_pending && (
                                formatting_involved
                                || (!original_formatting_is_known
                                    && entry.valueRuns !== undefined)
                            );
                            return (
                                <ExternalChangeItem
                                    key={`removed:${key}`}
                                    source_key={key}
                                    on_detach={handle_external_change_item_detach}
                                >
                                    <h3>{location}</h3>
                                    <div className="external-change-values">
                                        <div className="external-change-value-row">
                                            <span>Original file value</span>
                                            <code>{review_value(entry.base)}</code>
                                        </div>
                                        <div className="external-change-value-row">
                                            <span>Current file value</span>
                                            <code>(row no longer in file)</code>
                                        </div>
                                        {formatting_involved && (
                                            <>
                                                <div className="external-change-value-row">
                                                    <span>Original file formatting</span>
                                                    <code>{review_formatting(
                                                        entry.base,
                                                        entry.baseRuns,
                                                    )}</code>
                                                </div>
                                                <div className="external-change-value-row">
                                                    <span>Current file formatting</span>
                                                    <code>(row no longer in file)</code>
                                                </div>
                                            </>
                                        )}
                                        {entry.link !== undefined && (
                                            <>
                                                <div className="external-change-value-row">
                                                    <span>Original file link</span>
                                                    <code>{review_link(entry.baseLink ?? null)}</code>
                                                </div>
                                                <div className="external-change-value-row">
                                                    <span>Current file link</span>
                                                    <code>(row no longer in file)</code>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                    <div className="external-change-pending">
                                        {value_pending && (
                                            <>
                                                <span>Your pending edit</span>
                                                <code>{review_value(
                                                    external_change_pending_value(entry)
                                                )}</code>
                                            </>
                                        )}
                                        {pending_formatting_involved && (
                                            <>
                                                <span>Your pending formatting</span>
                                                <code>{review_formatting(
                                                    entry.value,
                                                    entry.valueRuns,
                                                )}</code>
                                            </>
                                        )}
                                        {entry.link !== undefined && (
                                            <>
                                                <span>Your pending link</span>
                                                <code>{review_link(entry.link)}</code>
                                            </>
                                        )}
                                    </div>
                                    <div className="external-change-item-actions">
                                        <button
                                            onClick={() => {
                                                // Writes this window's store, which
                                                // a window that must be reopened
                                                // no longer sends to the file.
                                                if (refused_for_reopen()) return;
                                                cancel_external_change_navigation();
                                                if (external_change_item_count === 1) {
                                                    grid_focus_ref.current?.focus();
                                                } else {
                                                    external_change_review_ref.current?.focus();
                                                }
                                                editing_ref.current?.discard_keys([key]);
                                                set_external_change_navigation_status('');
                                            }}
                                            aria-label={discard_label + ' for ' + location}
                                        >
                                            {discard_label}
                                        </button>
                                    </div>
                                </ExternalChangeItem>
                            );
                        })}
                    </ul>
                    <div className="external-change-review-status" aria-live="polite">
                        {external_change_navigation_status}
                    </div>
                </section>
            )}
            {/* Above the tabs, because the comparison spans the whole workbook. */}
            {compare_strip}
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
                        badges={sheet_badges}
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
                        badges={sheet_badges}
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
