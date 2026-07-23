import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MutableRefObject,
} from 'react';
import {
    CompactSelection,
    DataEditor,
    GridCellKind,
    type CellClickedEventArgs,
    type DataEditorRef,
    type DrawHeaderCallback,
    type EditableGridCell,
    type GridCell,
    type GridColumn,
    type HeaderClickedEventArgs,
    type GridKeyEventArgs,
    type GridMouseEventArgs,
    type GridSelection,
    type Item,
    type ProvideEditorCallback,
    type Rectangle,
} from '@glideapps/glide-data-grid';
import type { RenderedCell, SheetMeta } from '../data-source/interface';
import {
    EMPTY_TRANSFORM,
    type CellHighlightColor,
    type CellHighlightMutation,
    type CellHighlightSelection,
    type CsvDirtyMap,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type DisplayRowInterval,
    type MergeRange,
    type SheetCellHighlightState,
    type SheetTransformState,
    type SortDirection,
} from '../types';
import type { ColumnProjection } from './column-projection';
import { build_grid_columns } from './grid-model';
import { ContextMenu } from './context-menu';
import { cell_context_menu_items } from './cell-context-menu';
import { ColumnContextMenu, MultiColumnContextMenu } from './column-context-menu';
import {
    grid_selection_contains_column,
    header_drag_columns,
    header_drag_state_for_selection,
    selected_source_columns,
    type HeaderDragState,
} from './column-selection-model';
import { row_context_menu_items } from './row-context-menu';
import { draw_sort_glyphs, header_sort_metadata } from './header-sort-glyph';
import {
    append_sort,
    is_editable_target,
    replace_sort,
    transform_shortcut,
} from './transform-ui-model';
import {
    format_selection_tsv,
    copy_truncation_message,
    display_row_indices,
} from './grid-copy-model';
import { resolve_nav, is_copy_key } from './grid-nav-model';
import { move_active_cell } from './selection';
import { MergeIndex } from './merge-index';
import { build_grid_cell, type CellEditOverlay } from './cell-renderer';
import { use_editing, type DirtyEntry } from './use-editing';
import {
    collect_exact_dirty_edits,
    collect_save_edits,
    type LiveEdit,
} from './csv-save-model';
import {
    csv_save_operations_equal,
    resolve_csv_save_hydration,
} from './csv-save-lifecycle';
import {
    canvas_font,
    fit_column_widths,
    measurable_from_rendered,
    type MeasurableCell,
} from './fit-column-model';
import { CsvCellEditor, type CsvCellEditorProps } from './csv-cell-editor';
import { MergeOverlay, type MergeOverlayHandle } from './merge-overlay';
import {
    RowResizeOverlay,
    type RowResizeOverlayHandle,
} from './row-resize-overlay';
import { row_boundary_hit } from './row-resize-model';
import { read_overlay_editor_value } from './live-editor';
import {
    changed_highlight_keys,
    changed_tint_keys,
    visible_highlight_damage,
} from './grid-repaint-model';
import { expand_glide_selection } from './selection-glide';
import {
    grid_selection_contains_cell,
    grid_selection_contains_row,
    highlight_selection_may_have_renderable_highlight,
    highlight_selection_from_grid,
    selected_display_row_intervals,
} from './highlight-selection-model';
import { highlight_rgba } from './highlight-theme';
import { natural_row_height, row_height, type RowHeightOverrides } from './row-heights';

/** Pixel proximity to a row border that arms the resize strip. */
const ROW_RESIZE_TOLERANCE_PX = 5;

/** Resident-row cap sampled when auto-fitting columns (bounds the measure cost
 *  on huge sheets; we only ever measure already-loaded text, never force a
 *  fetch). */
const AUTO_FIT_SAMPLE_ROWS = 2000;
/** Glide exposes its ref before the internal scroller is always ready. Retry a
 * queued preview restore briefly, then leave it pending for the first visible
 * region callback to finish. */
const PREVIEW_RESTORE_MAX_ATTEMPTS = 8;
const PREVIEW_RESTORE_RETRY_MS = 16;
const PREVIEW_RESTORE_SETTLE_MS = 32;

/** Canvas-drawn tint for a cell holding an unsaved edit (low-alpha warning
 *  amber). Concrete rgba — `themeOverride.bgCell` is painted on canvas and can't
 *  resolve CSS `var()`. */
const DIRTY_BG = 'rgba(204, 167, 0, 0.16)';
/** Stronger reddish tint for an edit whose underlying cell drifted (conflict). */
const CONFLICT_BG = 'rgba(229, 75, 75, 0.22)';
import { use_row_loader } from './use-row-loader';
import { use_vscode_theme } from './vscode-theme';
import { vscode_api } from './use-state-sync';
import { scroll_preview_to_row } from './preview-scroll';
import '@glideapps/glide-data-grid/dist/index.css';

/**
 * Editing snapshot reported up to {@link App} so it can drive the toolbar dirty
 * indicator, persist pending edits, and surface the conflict banner — all
 * App-level concerns, while the dirty map itself lives next to the loader here.
 */
export interface EditingStatus {
    is_dirty: boolean;
    /** True while an open overlay editor differs from its base — an in-progress
     *  edit the user hasn't committed yet. Observable (state-driven) so App can
     *  react to it without polling the DOM. */
    has_live_uncommitted: boolean;
    /** True from the synchronous save boundary through its terminal result. */
    save_in_flight: boolean;
    /** Live `"row:col" → {value, base}` dirty map, for persistence + save. */
    edits: Record<string, DirtyEntry>;
    /** Keys whose underlying cell drifted since the edit (external change). */
    conflicted: string[];
}

/**
 * Imperative editing actions GridShell exposes to {@link App} (the toolbar
 * toggle and conflict banner live in App's layout, but the dirty map lives here
 * next to the loader). Populated into a ref App provides.
 */
export interface EditingHandle {
    /** Collect dirty + in-progress edits and post `saveCsv`; returns whether a
     *  save was actually posted (false when clean or already saving). */
    request_save(): boolean;
    /** Drop every dirty edit. */
    clear_dirty(): void;
    /** Drop only edits whose underlying cell drifted (conflict resolution). */
    discard_conflicted(): void;
    /** Snapshot the current Glide overlay into the source-keyed dirty map. */
    commit_live_edit(): void;
    /** True when there are committed edits or an open editor with changes. */
    has_uncommitted_changes(): boolean;
}

/** Imperative focus bridge used by App after generation-keyed remounts. */
export interface HighlightSelectionHandle {
    apply(color: CellHighlightColor): boolean;
    clear(): boolean;
}

export interface GridFocusHandle {
    /** Generation owned by the GridShell instance exposing this handle. */
    generation: number;
    /** Focus the mounted Glide grid; false while no DataEditor is available. */
    focus(): boolean;
}

export interface PendingPreviewScroll {
    row: number;
    sequence: number;
}

export interface GridShellProps {
    sheet_meta: SheetMeta;
    sheet_index: number;
    generation: number;
    /** Effective displayed row count (may be filtered). */
    row_count?: number;
    /** True while display rows are a view-only permutation of source rows. */
    transformed?: boolean;
    show_formatting: boolean;
    column_projection: ColumnProjection;
    /** Persisted widths keyed by canonical source column. */
    column_widths: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    row_heights: RowHeightOverrides;
    // Wired by the row-resize overlay (D-wire-3); accepted now so App's contract
    // is stable while the overlay lands.
    on_row_resize: (row: number, height: number) => void;
    merges: MergeRange[];
    preview_mode?: boolean;
    // Editing (Phase E). edit_mode is App-controlled (toolbar toggle); editing is
    // only possible when csv_editable. CSV sheets have no merges, so edits only
    // ever touch the plain-cell path.
    edit_mode?: boolean;
    csv_editable?: boolean;
    edit_session_id?: string;
    /** App-owned operation survives generation-keyed GridShell remounts. */
    save_operation?: CsvSaveOperation;
    save_lifecycle?: CsvSaveLifecycle;
    on_save_request?: (
        edits: Record<string, string>,
        dirty_edits: CsvDirtyMap,
    ) => CsvSaveOperation | undefined;
    initial_edits?: Record<string, string | DirtyEntry>;
    on_editing_change?: (status: EditingStatus) => void;
    // App provides this ref; GridShell populates it with imperative save/discard
    // actions so App's toolbar + conflict banner can drive editing that lives here.
    editing_ref?: MutableRefObject<EditingHandle | null>;
    // App provides this ref; GridShell populates it with a function that measures
    // loaded rows and returns fitted column widths (null when nothing is loaded).
    auto_fit_ref?: MutableRefObject<(() => Record<number, number> | null) | null>;
    /** App-owned bridge for restoring focus after generation-keyed remounts. */
    grid_focus_ref?: MutableRefObject<GridFocusHandle | null>;
    /** Latest preview scroll request, retained by App across GridShell remounts. */
    pending_preview_scroll?: PendingPreviewScroll | null;
    /** Clears the App-owned request only after Glide accepts the scroll. */
    on_preview_scroll_applied?: (sequence: number) => void;
    /** Reports the latest user-visible preview row to App across remounts. */
    on_preview_visible_row_change?: (row: number) => void;
    transform_state?: SheetTransformState;
    transform_sections?: boolean;
    transform_pending?: boolean;
    on_transform_change?: (state: SheetTransformState) => void;
    on_open_filter?: (
        source_column: number,
        anchor: { left: number; top: number },
        restore_focus: () => void,
    ) => void;
    on_hide_column?: (source_column: number) => void;
    on_hide_columns?: (source_columns: number[]) => void;
    on_hide_rows?: (display_rows: DisplayRowInterval[]) => void;
    /** Focus recovery target when hiding the final visible header removes Glide. */
    on_focus_columns?: () => void;
    cell_highlights?: SheetCellHighlightState;
    on_highlight_selection?: (
        selection: CellHighlightSelection,
        mutation: CellHighlightMutation,
    ) => void;
    on_highlight_selection_available_change?: (available: boolean) => void;
    highlight_ref?: MutableRefObject<HighlightSelectionHandle | null>;
}

/**
 * Glide DataEditor wrapper (Phase D): virtualized rows fed by the paged loader,
 * lettered columns from sheet meta, VS Code theming, scroll-driven fetching,
 * column-resize persistence, per-row variable heights, and merge-aware cells via
 * {@link build_grid_cell} (native span for horizontal merges; vertical/2D merges
 * blank here and painted by the overlay). Read-only; editing/selection restored
 * in Phase E.
 */
export function GridShell({
    sheet_meta,
    sheet_index,
    generation,
    row_count = sheet_meta.rowCount,
    transformed = false,
    show_formatting,
    column_projection,
    column_widths,
    on_column_resize,
    row_heights,
    on_row_resize,
    merges,
    preview_mode = false,
    edit_mode = false,
    csv_editable = false,
    edit_session_id,
    save_operation,
    save_lifecycle = { revision: 0, state: 'idle' },
    on_save_request = () => undefined,
    initial_edits,
    on_editing_change,
    editing_ref,
    auto_fit_ref,
    grid_focus_ref,
    pending_preview_scroll = null,
    on_preview_scroll_applied = () => {},
    on_preview_visible_row_change = () => {},
    transform_state = EMPTY_TRANSFORM,
    transform_sections = false,
    transform_pending = false,
    on_transform_change = () => {},
    on_open_filter = () => {},
    on_hide_column = () => {},
    on_hide_columns = () => {},
    on_hide_rows = () => {},
    on_focus_columns = () => {},
    cell_highlights,
    on_highlight_selection = () => {},
    on_highlight_selection_available_change,
    highlight_ref,
}: GridShellProps): React.JSX.Element {
    const visible_source_columns = column_projection.visible_to_source;
    const display_column_count = visible_source_columns.length;
    const has_visible_columns = display_column_count > 0;
    const loader = use_row_loader(
        sheet_index,
        row_count,
        generation,
        has_visible_columns,
    );
    const { theme, highContrast: high_contrast } = use_vscode_theme();
    const grid_ref = useRef<DataEditorRef | null>(null);
    const grid_root_ref = useRef<HTMLDivElement | null>(null);
    const overlay_ref = useRef<MergeOverlayHandle | null>(null);
    const row_resize_ref = useRef<RowResizeOverlayHandle | null>(null);
    const visible_ref = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 });
    const last_preview_row = useRef<number | null>(null);
    const applied_preview_sequence_ref = useRef<number | null>(null);
    const preview_restore_not_before_ref = useRef(0);
    const preview_restore_timer_ref = useRef<number | null>(null);
    const preview_restore_token_ref = useRef(0);

    useLayoutEffect(() => {
        if (!grid_focus_ref) return;
        const handle: GridFocusHandle = {
            generation,
            focus: () => {
                // Glide's ref can exist before its internal focus target is wired
                // after a remount. Prefer the mounted tabbable element itself.
                const target = grid_root_ref.current?.querySelector<HTMLElement>(
                    '[tabindex="0"]',
                );
                if (target) {
                    target.focus();
                    if (document.activeElement === target) return true;
                }
                const grid = grid_ref.current;
                if (!grid) return false;
                grid.focus();
                const active = document.activeElement;
                return !!active && !!grid_root_ref.current?.contains(active);
            },
        };
        grid_focus_ref.current = handle;
        return () => {
            if (grid_focus_ref.current === handle) grid_focus_ref.current = null;
        };
    }, [generation, grid_focus_ref, has_visible_columns]);

    // Controlled selection. We intercept every change to snap it onto whole
    // merges (a click/drag landing on a covered cell selects the merge block);
    // native Ctrl+C then copies the rectangle via `getCellsForSelection`.
    const [grid_selection, set_grid_selection] = useState<GridSelection>({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
    });

    // Right-click context menu, anchored at client coords with the cell that was
    // clicked (merge-snapped). Null when closed.
    const suppress_menu_restore_ref = useRef(false);
    const [context_menu, set_context_menu] = useState<({
        kind: 'cell';
        x: number;
        y: number;
        row: number;
        display_col: number;
        source_col: number;
    } | {
        kind: 'header';
        x: number;
        y: number;
        display_col: number;
        source_col: number;
    } | {
        kind: 'multi-column';
        x: number;
        y: number;
        /** Selected display columns (ascending) snapshotted at menu-open time. */
        display_cols: number[];
        /** Matching canonical source columns, in display order. */
        source_cols: number[];
    } | {
        kind: 'row';
        x: number;
        y: number;
        row: number;
        display_rows: DisplayRowInterval[];
    }) | null>(null);

    const columns = useMemo<GridColumn[]>(
        () => build_grid_columns(
            visible_source_columns,
            column_widths,
            sheet_meta.columnNames,
        ),
        [visible_source_columns, column_widths, sheet_meta.columnNames],
    );

    const sort_metadata = useMemo(
        () => header_sort_metadata(transform_state.sort),
        [transform_state.sort],
    );
    const show_sort_priority = transform_state.sort.length > 1;
    const draw_header: DrawHeaderCallback = useCallback((args, draw_content) => {
        draw_content();
        const source_column = visible_source_columns[args.columnIndex];
        const entry = source_column === undefined
            ? undefined
            : sort_metadata.get(source_column);
        if (entry) {
            draw_sort_glyphs(
                args.ctx,
                args.rect,
                args.theme,
                entry,
                show_sort_priority,
            );
        }
    }, [show_sort_priority, sort_metadata, visible_source_columns]);

    const merge_index = useMemo(() => new MergeIndex(merges), [merges]);
    const source_column_for_display = useCallback(
        (display_column: number) => visible_source_columns[display_column],
        [visible_source_columns],
    );
    const display_column_for_source = useCallback(
        (source_column: number) => column_projection.source_to_visible[source_column],
        [column_projection.source_to_visible],
    );

    const { ensure_rows, get_row, get_source_row, sample_loaded_rows, version } = loader;
    const lifecycle_operation = (
        save_lifecycle.state === 'active'
        || save_lifecycle.state === 'failed'
    )
        && save_lifecycle.operation.editSessionId === edit_session_id
        ? save_lifecycle.operation
        : undefined;
    const restored_save_operation = save_operation?.editSessionId === edit_session_id
        ? save_operation
        : save_lifecycle.state === 'active'
            ? lifecycle_operation
            : undefined;
    const editing_initial_edits = resolve_csv_save_hydration(
        { authoritative: save_lifecycle, operation: save_operation },
        edit_session_id,
        initial_edits,
    );
    // Values posted in the in-flight save; edit bases use these before reload.
    const saved_edits_ref = useRef<Record<string, string>>(
        restored_save_operation ? { ...restored_save_operation.edits } : {},
    );
    const save_operation_ref = useRef<CsvSaveOperation | undefined>(
        restored_save_operation,
    );
    const save_in_flight_ref = useRef(restored_save_operation !== undefined);

    // Read a cell's persisted raw text from the paged cache for the editing hook.
    // Stabilized against get_row's per-render identity; `version` in the deps
    // makes conflict detection re-run as freshly-loaded pages arrive.
    const get_row_ref = useRef(get_row);
    get_row_ref.current = get_row;
    const get_cell_raw = useCallback(
        (r: number, c: number): string | undefined => {
            const saved = saved_edits_ref.current[`${r}:${c}`];
            if (saved !== undefined) return saved;
            const row = get_row_ref.current(r);
            // Page not resident (evicted / not yet fetched): return undefined so
            // conflict detection treats it as unknown, never as a changed value.
            if (row === undefined) return undefined;
            const cell = row[c];
            return cell ? String(cell.raw ?? '') : '';
        },
        [version],
    );

    const {
        dirty_cells,
        conflicted_keys,
        commit_edit,
        clear_dirty,
        replace_dirty,
        clear_dirty_keys,
        discard_conflicted,
    } = use_editing(get_cell_raw, generation, editing_initial_edits);
    const dirty_cells_ref = useRef(dirty_cells);
    dirty_cells_ref.current = dirty_cells;
    const applied_save_lifecycle_revision_ref = useRef(save_lifecycle.revision);
    const [save_in_flight, set_save_in_flight] = useState(
        restored_save_operation !== undefined,
    );
    const editable_cells = edit_mode && csv_editable && !save_in_flight;

    useEffect(() => {
        if (
            !save_operation
            || save_operation.editSessionId !== edit_session_id
            || csv_save_operations_equal(save_operation_ref.current, save_operation)
        ) return;
        save_operation_ref.current = save_operation;
        saved_edits_ref.current = { ...save_operation.edits };
        save_in_flight_ref.current = true;
        set_save_in_flight(true);
    }, [edit_session_id, save_operation]);

    const apply_save_lifecycle = useCallback((lifecycle: CsvSaveLifecycle) => {
        if (lifecycle.revision <= applied_save_lifecycle_revision_ref.current) return;
        applied_save_lifecycle_revision_ref.current = lifecycle.revision;
        if (lifecycle.state === 'active') {
            const operation = lifecycle.operation;
            if (operation.editSessionId !== edit_session_id) return;
            const locked = save_operation_ref.current;
            if (locked && !csv_save_operations_equal(locked, operation)) return;
            save_operation_ref.current = operation;
            saved_edits_ref.current = { ...operation.edits };
            const exact: CsvDirtyMap = Object.fromEntries(
                Object.entries(operation.dirtyEdits),
            );
            dirty_cells_ref.current = new Map(Object.entries(exact));
            replace_dirty(exact);
            save_in_flight_ref.current = true;
            set_save_in_flight(true);
            return;
        }

        const operation = save_operation_ref.current;
        // Idle carries no proposal identity, so it cannot settle an operation that
        // may have been proposed after that idle projection was created.
        if (lifecycle.state === 'idle' || !operation) return;
        if (
            lifecycle.state === 'failed'
                ? lifecycle.operation.editSessionId !== edit_session_id
                : edit_session_id !== undefined
                    && lifecycle.operation.editSessionId !== edit_session_id
        ) return;
        if (!csv_save_operations_equal(lifecycle.operation, operation)) return;

        const restore = (resolve_csv_save_hydration(
            { authoritative: lifecycle },
            edit_session_id,
            Object.fromEntries(dirty_cells_ref.current),
        ) ?? {}) as CsvDirtyMap;
        dirty_cells_ref.current = new Map(Object.entries(restore));
        replace_dirty(restore);
        save_operation_ref.current = undefined;
        saved_edits_ref.current = {};
        save_in_flight_ref.current = false;
        set_save_in_flight(false);
    }, [edit_session_id, replace_dirty]);

    useEffect(() => {
        apply_save_lifecycle(save_lifecycle);
    }, [apply_save_lifecycle, save_lifecycle]);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (
                msg?.type !== 'saveOperationStarted'
                && msg?.type !== 'saveResult'
                && msg?.type !== 'editSessionRevoked'
            ) return;
            apply_save_lifecycle(msg.lifecycle as CsvSaveLifecycle);
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [apply_save_lifecycle]);

    // Observable mirror of the open overlay's dirtiness (true when an open editor
    // differs from its base). Declared here so the editing-status effect below can
    // depend on it; driven by the tracking editor wrapper further down.
    const [live_uncommitted, set_live_uncommitted] = useState(false);

    // Surface editing state to App (toolbar dot, pending-edit persistence,
    // conflict banner). Object.fromEntries snapshots the live Map per change.
    useEffect(() => {
        on_editing_change?.({
            is_dirty: dirty_cells.size > 0,
            has_live_uncommitted: live_uncommitted,
            save_in_flight,
            edits: Object.fromEntries(dirty_cells),
            conflicted: [...conflicted_keys],
        });
    }, [dirty_cells, conflicted_keys, live_uncommitted, on_editing_change, save_in_flight]);

    // Persist the dirty map to the host so edits survive a webview reload. Posting
    // null clears the stored state. Runs on the initial render too: a restored map
    // simply round-trips back (harmless), and an empty map posts null (already so).
    useEffect(() => {
        if (!edit_mode || !edit_session_id || save_in_flight_ref.current) return;
        vscode_api.postMessage({
            type: 'pendingEditsChanged',
            editSessionId: edit_session_id,
            edits: dirty_cells.size > 0 ? Object.fromEntries(dirty_cells) : null,
        });
    }, [dirty_cells, edit_mode, edit_session_id, save_in_flight_ref]);

    // Mirrors read imperatively by the save handle (which must stay stable so the
    // ref App holds doesn't churn): the live dirty map and current selection.
    // get_cell_content reads dirty/conflict state through refs so its identity
    // stays stable across edits — otherwise every commit would rebuild the
    // closure and invalidate Glide's whole per-cell cache. Targeted repaints
    // (below) drive the actual damage instead.
    const conflicted_keys_ref = useRef(conflicted_keys);
    conflicted_keys_ref.current = conflicted_keys;
    const grid_selection_ref = useRef(grid_selection);
    grid_selection_ref.current = grid_selection;
    const current_highlight_selection = useCallback(() => (
        highlight_selection_from_grid(
            grid_selection_ref.current,
            row_count,
            column_projection,
            merges,
        )?.selection ?? null
    ), [column_projection, merges, row_count]);
    const mutate_highlight_selection = useCallback((mutation: CellHighlightMutation): boolean => {
        const selection = current_highlight_selection();
        if (!selection) return false;
        on_highlight_selection(selection, mutation);
        return true;
    }, [current_highlight_selection, on_highlight_selection]);
    useLayoutEffect(() => {
        if (!highlight_ref) return;
        const handle: HighlightSelectionHandle = {
            apply: (color) => mutate_highlight_selection({ type: 'set', color }),
            clear: () => mutate_highlight_selection({ type: 'clear' }),
        };
        highlight_ref.current = handle;
        return () => {
            if (highlight_ref.current === handle) highlight_ref.current = null;
        };
    }, [highlight_ref, mutate_highlight_selection]);
    const highlight_selection_available = current_highlight_selection() !== null;
    useEffect(() => {
        on_highlight_selection_available_change?.(highlight_selection_available);
    }, [highlight_selection_available, on_highlight_selection_available_change]);
    const focused_source_column_ref = useRef<number | undefined>(
        visible_source_columns[0],
    );
    const previous_projection_ref = useRef(column_projection);
    useEffect(() => {
        if (previous_projection_ref.current === column_projection) return;
        previous_projection_ref.current = column_projection;
        const focused_source = focused_source_column_ref.current;
        focused_source_column_ref.current = focused_source !== undefined
            && visible_source_columns.includes(focused_source)
            ? focused_source
            : visible_source_columns[0];
        set_grid_selection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
        });
        set_context_menu(null);
        row_resize_ref.current?.set_target(null);
        const grid = grid_ref.current;
        const visible = visible_ref.current;
        if (grid && visible.width > 0 && visible.height > 0) {
            const cells: { cell: Item }[] = [];
            const end_column = Math.min(
                visible.x + visible.width,
                display_column_count,
            );
            for (let row = visible.y; row < visible.y + visible.height; row++) {
                for (let col = visible.x; col < end_column; col++) {
                    cells.push({ cell: [col, row] });
                }
            }
            if (cells.length > 0) grid.updateCells(cells);
        }
        overlay_ref.current?.repaint();
    }, [column_projection, display_column_count, visible_source_columns]);

    const cancel_pending_preview_restore = useCallback(() => {
        preview_restore_token_ref.current += 1;
        if (preview_restore_timer_ref.current !== null) {
            window.clearTimeout(preview_restore_timer_ref.current);
            preview_restore_timer_ref.current = null;
        }
    }, []);

    const restore_pending_preview_row = useCallback((): boolean => {
        const pending = pending_preview_scroll;
        const grid = grid_ref.current;
        if (
            !preview_mode
            || !pending
            || applied_preview_sequence_ref.current === pending.sequence
            || Date.now() < preview_restore_not_before_ref.current
            || !grid
            || display_column_count <= 0
            || row_count <= 0
        ) {
            return false;
        }
        const column = Math.min(
            Math.max(0, visible_ref.current.x),
            display_column_count - 1,
        );
        const row = Math.min(Math.max(0, pending.row), row_count - 1);
        const bounds = grid.getBounds(column, row);
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
        cancel_pending_preview_restore();
        applied_preview_sequence_ref.current = pending.sequence;
        // Consume Glide's matching visible-region callback locally. Programmatic
        // editor/meta restores must not echo the restored row back to the host.
        last_preview_row.current = row;
        scroll_preview_to_row(grid, row);
        on_preview_visible_row_change(row);
        on_preview_scroll_applied(pending.sequence);
        return true;
    }, [
        cancel_pending_preview_restore,
        display_column_count,
        on_preview_scroll_applied,
        on_preview_visible_row_change,
        pending_preview_scroll,
        preview_mode,
        row_count,
    ]);

    const schedule_pending_preview_restore = useCallback(() => {
        cancel_pending_preview_restore();
        const token = preview_restore_token_ref.current;
        let attempt = 0;
        const retry = () => {
            if (preview_restore_token_ref.current !== token) return;
            preview_restore_timer_ref.current = null;
            if (restore_pending_preview_row()) return;
            attempt += 1;
            if (attempt >= PREVIEW_RESTORE_MAX_ATTEMPTS) return;
            preview_restore_timer_ref.current = window.setTimeout(
                retry,
                PREVIEW_RESTORE_RETRY_MS,
            );
        };
        preview_restore_timer_ref.current = window.setTimeout(
            retry,
            PREVIEW_RESTORE_SETTLE_MS,
        );
    }, [cancel_pending_preview_restore, restore_pending_preview_row]);

    // Hide-all removes only Glide's DataEditor, not GridShell. Preserve the last
    // visible display location and restore it when any columns become visible again.
    const previous_has_visible_columns_ref = useRef(has_visible_columns);
    useEffect(() => {
        const previously_visible = previous_has_visible_columns_ref.current;
        previous_has_visible_columns_ref.current = has_visible_columns;
        if (!has_visible_columns || row_count <= 0) {
            cancel_pending_preview_restore();
            return;
        }
        if (pending_preview_scroll) {
            preview_restore_not_before_ref.current = Date.now()
                + PREVIEW_RESTORE_SETTLE_MS;
            schedule_pending_preview_restore();
            return cancel_pending_preview_restore;
        }
        if (
            previously_visible
            || visible_ref.current.width <= 0
            || visible_ref.current.height <= 0
        ) {
            return;
        }
        const column = Math.min(
            Math.max(0, visible_ref.current.x),
            display_column_count - 1,
        );
        const row = Math.min(Math.max(0, visible_ref.current.y), row_count - 1);
        grid_ref.current?.scrollTo(column, row);
    }, [
        cancel_pending_preview_restore,
        display_column_count,
        generation,
        has_visible_columns,
        pending_preview_scroll,
        row_count,
        schedule_pending_preview_restore,
    ]);

    // Read the value + location of an open Glide overlay editor. Glide owns the
    // overlay (our hook's editing_cell stays null), so the location comes from the
    // selected cell and the live text from the portalled .gdg-clip-region input.
    const read_live_edit = useCallback((): LiveEdit | null => {
        const value = read_overlay_editor_value(document);
        if (value === null) return null;
        const loc = grid_selection_ref.current.current?.cell;
        if (!loc) return null;
        const [display_column, row] = loc;
        const source_column = source_column_for_display(display_column);
        if (source_column === undefined) return null;
        return {
            key: `${row}:${source_column}`,
            value,
            original: get_cell_raw(row, source_column) ?? '',
        };
    }, [get_cell_raw, source_column_for_display]);

    // The tracking editor wrapper (provide_editor) refreshes live_uncommitted on
    // open and on every keystroke and clears it on close, so the editing-status
    // effect re-runs whenever the live editor's cleanliness changes — App reacts
    // to that instead of polling.
    const read_live_edit_ref = useRef(read_live_edit);
    read_live_edit_ref.current = read_live_edit;
    const refresh_live_uncommitted = useCallback(() => {
        const live = read_live_edit_ref.current();
        set_live_uncommitted(!!live && live.value !== live.original);
    }, []);

    // Collect committed dirty edits + any in-progress editor and post saveCsv.
    // Returns false (no message sent) when there is nothing to save.
    const request_save = useCallback((): boolean => {
        if (save_in_flight_ref.current || !edit_session_id) return false;
        const live = read_live_edit();
        const edits = collect_save_edits(dirty_cells_ref.current, live);
        if (Object.keys(edits).length === 0) return false;
        const dirty_edits = collect_exact_dirty_edits(dirty_cells_ref.current, live);
        if (!dirty_edits) {
            vscode_api.postMessage({
                type: 'showWarning',
                message: 'Load every edited row before saving so its conflict base can be verified.',
            });
            return false;
        }
        const operation = on_save_request(edits, dirty_edits);
        if (
            !operation
            || operation.editSessionId !== edit_session_id
            || operation.saveRequestId.length === 0
        ) return false;
        if (live) {
            const [row, source_column] = live.key.split(':').map(Number);
            if (Number.isInteger(row) && Number.isInteger(source_column)) {
                // Accept the open editor's current value before closing the mutation
                // boundary. React state may commit later, so mirror it immediately for
                // all synchronous guards and failure restoration.
                commit_edit(row, source_column, live.value);
                const next = new Map(dirty_cells_ref.current);
                if (live.value === live.original) next.delete(live.key);
                else next.set(live.key, { value: live.value, base: live.original });
                dirty_cells_ref.current = next;
            }
        }
        save_operation_ref.current = operation;
        saved_edits_ref.current = { ...operation.edits };
        // This ref is the actual boundary: every mutation handler consults it before
        // React has a chance to render the disabled grid.
        save_in_flight_ref.current = true;
        set_save_in_flight(true);
        set_live_uncommitted(false);
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        vscode_api.postMessage({
            type: 'saveCsv',
            operation,
        });
        return true;
    }, [
        commit_edit,
        edit_session_id,
        on_save_request,
        read_live_edit,
        save_in_flight_ref,
    ]);

    const commit_live_edit = useCallback((): void => {
        if (save_in_flight_ref.current) return;
        const live = read_live_edit();
        if (!live) return;
        const [row, source_column] = live.key.split(':').map(Number);
        if (!Number.isInteger(row) || !Number.isInteger(source_column)) return;
        commit_edit(row, source_column, live.value);
        set_live_uncommitted(false);
    }, [commit_edit, read_live_edit, save_in_flight_ref]);

    const has_uncommitted_changes = useCallback((): boolean => {
        if (dirty_cells_ref.current.size > 0) return true;
        const live = read_live_edit();
        return !!live && live.value !== live.original;
    }, [read_live_edit]);

    // Cmd/Ctrl+S saves while editing. The custom editor lets this bubble; here we
    // catch it at the window so it works whether or not an overlay is focused.
    useEffect(() => {
        if (!editable_cells) return;
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                request_save();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [editable_cells, request_save]);

    const guarded_clear_dirty = useCallback(() => {
        if (save_in_flight_ref.current) return;
        clear_dirty();
    }, [clear_dirty, save_in_flight_ref]);
    const guarded_discard_conflicted = useCallback(() => {
        if (save_in_flight_ref.current) return;
        discard_conflicted();
    }, [discard_conflicted, save_in_flight_ref]);

    // Expose the imperative actions to App through the ref it provides.
    useEffect(() => {
        if (!editing_ref) return;
        editing_ref.current = {
            request_save,
            clear_dirty: guarded_clear_dirty,
            discard_conflicted: guarded_discard_conflicted,
            commit_live_edit,
            has_uncommitted_changes,
        };
        return () => {
            editing_ref.current = null;
        };
    }, [
        editing_ref,
        request_save,
        guarded_clear_dirty,
        guarded_discard_conflicted,
        commit_live_edit,
        has_uncommitted_changes,
    ]);

    // --- Column auto-fit (canvas measureText over sampled loaded rows) ---------
    // Offscreen 2D context, created lazily. measureText returns CSS px, matching
    // the units column widths use, so no devicePixelRatio scaling is needed.
    const measure_ctx_ref = useRef<CanvasRenderingContext2D | null>(null);
    const font_family = theme.fontFamily ?? 'sans-serif';
    // Stabilize the per-render loader closure so the ref-population effect below
    // doesn't re-run every render.
    const sample_loaded_rows_ref = useRef(sample_loaded_rows);
    sample_loaded_rows_ref.current = sample_loaded_rows;

    const compute_auto_fit = useCallback((): Record<number, number> | null => {
        if (!has_visible_columns) return null;
        if (!measure_ctx_ref.current) {
            measure_ctx_ref.current = document
                .createElement('canvas')
                .getContext('2d');
        }
        const ctx = measure_ctx_ref.current;
        if (!ctx) return null;
        const sample = sample_loaded_rows_ref.current(AUTO_FIT_SAMPLE_ROWS);
        if (sample.length === 0) return null;
        const cells = sample.map((row) => {
            const visible_cells: Partial<Record<number, MeasurableCell | null>> = {};
            for (const source_column of visible_source_columns) {
                visible_cells[source_column] = measurable_from_rendered(
                    row[source_column] ?? null,
                    show_formatting,
                );
            }
            return visible_cells;
        });
        const measure = (cell: MeasurableCell): number => {
            ctx.font = canvas_font(cell.bold, cell.italic, font_family);
            return ctx.measureText(cell.text).width;
        };
        return fit_column_widths(cells, visible_source_columns, measure);
    }, [
        has_visible_columns,
        show_formatting,
        font_family,
        visible_source_columns,
    ]);

    useEffect(() => {
        if (!auto_fit_ref) return;
        auto_fit_ref.current = compute_auto_fit;
        return () => {
            auto_fit_ref.current = null;
        };
    }, [auto_fit_ref, compute_auto_fit]);

    const get_highlight_background = useCallback((
        source_row: number,
        source_column: number,
    ): string | undefined => {
        const color = cell_highlights?.cells[`${source_row}:${source_column}`];
        return color ? highlight_rgba(color, high_contrast) : undefined;
    }, [cell_highlights, high_contrast]);

    const get_cell_content = useCallback(
        (cell: Item): GridCell => {
            const [display_column, row] = cell;
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) {
                return {
                    kind: GridCellKind.Text,
                    data: '',
                    displayData: '',
                    allowOverlay: false,
                };
            }
            const key = `${row}:${source_column}`;
            const dirty = dirty_cells_ref.current.get(key);
            const merge = merge_index.entry_at(row, source_column);
            const highlight_source_row = get_source_row(merge?.startRow ?? row);
            const highlight_source_column = merge?.startCol ?? source_column;
            const highlight_bg = highlight_source_row === undefined
                ? undefined
                : get_highlight_background(
                    highlight_source_row,
                    highlight_source_column,
                );
            // Tint + dirty text whenever an edit exists; open the overlay only in
            // edit mode. Empty/unloaded cells stay editable so blanks can be typed.
            // dirty/conflict read via refs (see conflicted_keys_ref) so this
            // closure's identity doesn't churn per edit; the targeted repaint
            // effect damages the cells whose tint actually changed.
            let overlay: CellEditOverlay | undefined;
            if (editable_cells || dirty || highlight_bg) {
                overlay = {
                    editable: editable_cells,
                    dirty_value: dirty?.value,
                    bg: dirty
                        ? conflicted_keys_ref.current.has(key)
                            ? CONFLICT_BG
                            : DIRTY_BG
                        : highlight_bg,
                };
            }
            return build_grid_cell(
                row,
                source_column,
                get_row(row),
                merge_index,
                show_formatting,
                overlay,
            );
        },
        // version: bumps when a page lands so the closure (and the redraw effect) refresh.
        [
            get_row,
            show_formatting,
            version,
            merge_index,
            editable_cells,
            source_column_for_display,
            get_source_row,
            get_highlight_background,
        ],
    );

    // Glide opens its own overlay editor; it reports the committed value here
    // with the cell location, which we fold into the dirty map.
    const on_cell_edited = useCallback(
        (cell: Item, new_value: EditableGridCell) => {
            if (save_in_flight_ref.current) return;
            const [display_column, row] = cell;
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) return;
            const text =
                new_value.kind === GridCellKind.Text ? new_value.data ?? '' : '';
            commit_edit(row, source_column, text);
            // Auto-grow the row to fit hard line breaks (Shift+Alt+Enter),
            // mirroring the old renderer. Only ever grows a row, never shrinks a
            // user-sized one; repaints the whole row + overlay at the new height.
            if (text.includes('\n')) {
                const needed = natural_row_height(text);
                if (needed > row_height(row_heights, row)) {
                    on_row_resize(row, needed);
                    const cells: { cell: Item }[] = [];
                    for (let display_column = 0; display_column < display_column_count; display_column++) {
                        cells.push({ cell: [display_column, row] });
                    }
                    grid_ref.current?.updateCells(cells);
                    overlay_ref.current?.repaint();
                    return;
                }
            }
            grid_ref.current?.updateCells([{ cell: [display_column, row] }]);
        },
        [
            commit_edit,
            row_heights,
            on_row_resize,
            display_column_count,
            source_column_for_display,
            save_in_flight_ref,
        ],
    );

    // Tracking wrapper around the custom CSV editor: it makes the open overlay's
    // dirtiness observable (live_uncommitted) so App doesn't have to poll the DOM.
    // Refreshes on open and on every keystroke, clears on close. Memoized so its
    // identity is stable — Glide would otherwise remount (and unfocus) the editor
    // on each parent render.
    const tracking_editor = useMemo(() => {
        function TrackingCsvCellEditor(props: CsvCellEditorProps): React.JSX.Element {
            useEffect(() => {
                refresh_live_uncommitted();
                return () => set_live_uncommitted(false);
            }, []);
            const handle_change = (next: GridCell) => {
                if (save_in_flight_ref.current) return;
                props.onChange(next);
                refresh_live_uncommitted();
            };
            return <CsvCellEditor {...props} onChange={handle_change} />;
        }
        return TrackingCsvCellEditor;
    }, [refresh_live_uncommitted, save_in_flight_ref]);

    // Custom CSV overlay editor (Enter/Tab advance, Shift/Alt+Enter newline, Esc
    // cancel). Only consulted for editable Text cells.
    const provide_editor = useCallback<ProvideEditorCallback<GridCell>>(
        (cell) => {
            if (
                save_in_flight_ref.current
                || !editable_cells
                || cell.kind !== GridCellKind.Text
            ) return undefined;
            // disablePadding/disableStyling: the editor carries its own
            // .cell-editor-input border + background, so suppress Glide's overlay box.
            return { editor: tracking_editor, disablePadding: true, disableStyling: true };
        },
        [editable_cells, save_in_flight_ref, tracking_editor],
    );

    const get_row_height = useCallback(
        (row: number) => row_height(row_heights, row),
        [row_heights],
    );

    // Arm/clear the row-resize strip as the pointer nears a row border. Glide's
    // hover args give the cell's client `bounds` + in-cell `localEventY`.
    const on_item_hovered = useCallback(
        (args: GridMouseEventArgs) => {
            // Header drag-select: while the primary button that started on a
            // header stays down, sweep the hovered column into the selection.
            // (Glide suppresses hover events during a column resize drag, so
            // this never fires while resizing.)
            const drag = header_drag_ref.current;
            if (drag) {
                if ((args.buttons & 1) === 0) {
                    header_drag_ref.current = null;
                } else if (
                    (args.kind === 'header' || args.kind === 'cell')
                    && args.location[0] >= 0
                ) {
                    const columns = header_drag_columns(
                        drag,
                        args.location[0],
                        display_column_count,
                    );
                    if (!columns.equals(grid_selection_ref.current.columns)) {
                        set_grid_selection({
                            columns,
                            rows: CompactSelection.empty(),
                        });
                    }
                }
            }
            if (transformed) {
                row_resize_ref.current?.set_target(null);
                return;
            }
            if (args.kind !== 'cell') {
                row_resize_ref.current?.set_target(null);
                return;
            }
            const row = args.location[1];
            const hit = row_boundary_hit(
                row,
                args.bounds.y,
                args.bounds.height,
                args.localEventY,
                ROW_RESIZE_TOLERANCE_PX,
            );
            row_resize_ref.current?.set_target(
                hit
                    ? {
                          row: hit.row,
                          boundary_y: hit.boundary_y,
                          height: row_height(row_heights, hit.row),
                      }
                    : null,
            );
        },
        [display_column_count, row_heights, transformed],
    );

    // Live drag: persist the new height (mirrors column resize) and nudge Glide +
    // the merge overlay to redraw the affected row at its new height.
    const handle_row_resize_drag = useCallback(
        (row: number, height: number) => {
            on_row_resize(row, height);
            const cells: { cell: Item }[] = [];
            for (let display_column = 0; display_column < display_column_count; display_column++) {
                cells.push({ cell: [display_column, row] });
            }
            grid_ref.current?.updateCells(cells);
            overlay_ref.current?.repaint();
        },
        [on_row_resize, display_column_count],
    );

    // Armed by a header mousedown (Glide selects the column and reports it via
    // onGridSelectionChange before any drag movement); consumed by hover events
    // while the primary button stays down to grow the column selection.
    const header_drag_ref = useRef<HeaderDragState | null>(null);

    // A release outside the grid produces no zero-button grid hover, so without
    // this a later press elsewhere could resume a long-finished header drag.
    useEffect(() => {
        // Deferred one macrotask: on touch, pointerup precedes Glide's touchend
        // header selection, which would re-arm the ref right after a synchronous
        // clear. Deferring runs the clear after every completion handler.
        let timer: number | undefined;
        const end_header_drag = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                header_drag_ref.current = null;
            }, 0);
        };
        window.addEventListener('pointerup', end_header_drag);
        window.addEventListener('blur', end_header_drag);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('pointerup', end_header_drag);
            window.removeEventListener('blur', end_header_drag);
        };
    }, []);

    const on_grid_selection_change = useCallback(
        (sel: GridSelection) => {
            if (!sel.current) {
                header_drag_ref.current = sel.columns.length > 0
                    ? header_drag_state_for_selection(
                        grid_selection_ref.current.columns,
                        sel.columns,
                    )
                    : null;
                set_grid_selection(sel);
                return;
            }
            header_drag_ref.current = null;
            const { cell, range } = expand_glide_selection(
                sel.current.cell,
                sel.current.range,
                merges,
            );
            focused_source_column_ref.current = source_column_for_display(cell[0]);
            set_grid_selection({
                columns: sel.columns,
                rows: sel.rows,
                current: { cell, range, rangeStack: sel.current.rangeStack },
            });
        },
        [merges, source_column_for_display],
    );

    // --- Context menu: copy + select actions over the paged cache -------------
    const safe_write_to_clipboard = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            console.error('Failed to write to clipboard', error);
        }
    }, []);

    // Serialize an ordered source-column/row selection from the paged cache and
    // write it to the clipboard. Reads via get_row_ref so the callback stays stable
    // across page loads. When the copy is clipped (non-resident rows or the row
    // cap) the available data is still copied, but the host surfaces a warning.
    const copy_source_selection = useCallback((
        selection: Parameters<typeof format_selection_tsv>[0],
        include_header = false,
    ) => {
        // Snapshot the displayed edit layers once per copy. A row must still be
        // resident before edits are overlaid: one known dirty cell must not make an
        // otherwise-unloaded row look complete or suppress the nonresident warning.
        const dirty = dirty_cells_ref.current;
        const live = read_live_edit();
        const get_displayed_row = (
            row_index: number,
        ): (RenderedCell | null)[] | undefined => {
            const source_row = get_row_ref.current(row_index);
            if (source_row === undefined) return undefined;
            let displayed_row: (RenderedCell | null)[] | undefined;
            for (const source_column of selection.source_columns) {
                const key = `${row_index}:${source_column}`;
                const displayed_value = live?.key === key
                    ? live.value
                    : dirty.get(key)?.value;
                if (displayed_value === undefined) continue;
                displayed_row ??= [...source_row];
                const source_cell = source_row[source_column];
                displayed_row[source_column] = {
                    raw: displayed_value,
                    formatted: displayed_value,
                    bold: source_cell?.bold ?? false,
                    italic: source_cell?.italic ?? false,
                    rawType: 'string',
                };
            }
            return displayed_row ?? source_row;
        };
        const result = format_selection_tsv(
            selection,
            get_displayed_row,
            merge_index,
            show_formatting,
        );
        const warning = copy_truncation_message(result);
        if (warning) {
            vscode_api.postMessage({ type: 'showWarning', message: warning });
        }
        const header = include_header
            ? selection.source_columns.map((source_column) =>
                sheet_meta.columnNames?.[source_column]
                || columns[display_column_for_source(source_column) ?? -1]?.title
                || `Column ${source_column + 1}`,
            ).join('\t')
            : '';
        void safe_write_to_clipboard(
            header ? `${header}${result.text ? `\n${result.text}` : ''}` : result.text,
        );
    }, [
        columns,
        display_column_for_source,
        merge_index,
        read_live_edit,
        sheet_meta.columnNames,
        show_formatting,
        safe_write_to_clipboard,
    ]);

    const copy_rect = useCallback(
        (rect: Rectangle, include_header = false) => {
            copy_source_selection({
                y: rect.y,
                height: rect.height,
                source_columns: visible_source_columns.slice(
                    rect.x,
                    rect.x + rect.width,
                ),
            }, include_header);
        },
        [copy_source_selection, visible_source_columns],
    );

    const copy_display_rows = useCallback((intervals: readonly DisplayRowInterval[]) => {
        const row_count_total = intervals.reduce(
            (total, interval) => total + interval.end - interval.start + 1,
            0,
        );
        copy_source_selection({
            row_indices: display_row_indices(intervals),
            row_count: row_count_total,
            source_columns: visible_source_columns,
        });
    }, [copy_source_selection, visible_source_columns]);

    const select_rect = useCallback((anchor: Item, range: Rectangle) => {
        focused_source_column_ref.current = source_column_for_display(anchor[0]);
        set_grid_selection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: { cell: anchor, range, rangeStack: [] },
        });
    }, [source_column_for_display]);

    const select_row = useCallback(
        (row: number) => {
            if (display_column_count === 0) return;
            select_rect([0, row], {
                x: 0,
                y: row,
                width: display_column_count,
                height: 1,
            });
        },
        [display_column_count, select_rect],
    );

    const select_column = useCallback(
        (col: number) => {
            if (row_count === 0) return;
            select_rect([col, 0], {
                x: col,
                y: 0,
                width: 1,
                height: row_count,
            });
        },
        [row_count, select_rect],
    );

    const select_all = useCallback(() => {
        if (row_count === 0 || display_column_count === 0) return;
        select_rect([0, 0], {
            x: 0,
            y: 0,
            width: display_column_count,
            height: row_count,
        });
    }, [row_count, display_column_count, select_rect]);

    const hide_source_column = useCallback((source_column: number) => {
        if (display_column_count === 1) {
            // The projection update removes Glide entirely, so ContextMenu's normal
            // grid restoration has no target.
            suppress_menu_restore_ref.current = true;
            on_hide_column(source_column);
            window.setTimeout(on_focus_columns, 0);
            return;
        }
        on_hide_column(source_column);
    }, [display_column_count, on_focus_columns, on_hide_column]);

    const discard_edit = useCallback(
        (row: number, display_column: number, source_column: number) => {
            if (save_in_flight_ref.current) return;
            clear_dirty_keys(new Set([`${row}:${source_column}`]));
            grid_ref.current?.updateCells([{ cell: [display_column, row] }]);
        },
        [clear_dirty_keys, save_in_flight_ref],
    );

    const apply_column_sort = useCallback((
        source_column: number,
        direction: SortDirection,
        append: boolean,
    ) => {
        if (!transform_sections || transform_pending) return;
        on_transform_change({
            ...transform_state,
            sort: append
                ? append_sort(transform_state.sort, source_column, direction)
                : replace_sort(source_column, direction),
        });
    }, [
        on_transform_change,
        transform_pending,
        transform_sections,
        transform_state,
    ]);

    const clear_filter_on_column = useCallback((source_column: number) => {
        if (!transform_sections || transform_pending) return;
        on_transform_change({
            ...transform_state,
            filters: transform_state.filters.filter((entry) =>
                entry.colIndex !== source_column),
        });
    }, [
        on_transform_change,
        transform_pending,
        transform_sections,
        transform_state,
    ]);

    const hide_source_columns_multi = useCallback((source_columns: number[]) => {
        if (source_columns.length >= display_column_count) {
            // Hiding every visible column removes Glide, so ContextMenu's normal
            // grid restoration has no target (mirrors hide_source_column).
            suppress_menu_restore_ref.current = true;
            on_hide_columns(source_columns);
            window.setTimeout(on_focus_columns, 0);
            return;
        }
        on_hide_columns(source_columns);
    }, [display_column_count, on_focus_columns, on_hide_columns]);

    // Multi-column sort: replace the entire sort with one key per selected
    // column, in display order, all in the same direction.
    const apply_multi_column_sort = useCallback((
        source_columns: number[],
        direction: SortDirection,
    ) => {
        if (!transform_sections || transform_pending) return;
        if (source_columns.length === 0) return;
        on_transform_change({
            ...transform_state,
            sort: source_columns.map((colIndex) => ({ colIndex, direction })),
        });
    }, [
        on_transform_change,
        transform_pending,
        transform_sections,
        transform_state,
    ]);

    const focus_header_column = useCallback((display_column: number) => {
        const source_column = source_column_for_display(display_column);
        if (source_column !== undefined) focused_source_column_ref.current = source_column;
    }, [source_column_for_display]);

    const select_header_column = useCallback((display_column: number) => {
        const source_column = source_column_for_display(display_column);
        if (source_column === undefined) return;
        focused_source_column_ref.current = source_column;
        set_grid_selection({
            columns: CompactSelection.fromSingleSelection(display_column),
            rows: CompactSelection.empty(),
        });
    }, [source_column_for_display]);

    const on_header_context_menu = useCallback((
        display_column: number,
        event: HeaderClickedEventArgs,
    ) => {
        event.preventDefault();
        header_drag_ref.current = null;
        const source_column = source_column_for_display(display_column);
        if (source_column === undefined) return;
        suppress_menu_restore_ref.current = false;
        const x = event.bounds.x + event.localEventX;
        const y = event.bounds.y + event.localEventY;
        // Right-clicking inside a multi-column selection keeps it and opens the
        // range menu (mirrors the row-marker menu); outside, collapse to the
        // clicked column as before.
        if (grid_selection_contains_column(grid_selection_ref.current, display_column)) {
            const { display_cols, source_cols } = selected_source_columns(
                grid_selection_ref.current,
                source_column_for_display,
            );
            if (source_cols.length > 1) {
                focused_source_column_ref.current = source_column;
                set_context_menu({
                    kind: 'multi-column',
                    x,
                    y,
                    display_cols,
                    source_cols,
                });
                return;
            }
        }
        select_header_column(display_column);
        set_context_menu({
            kind: 'header',
            x,
            y,
            display_col: display_column,
            source_col: source_column,
        });
    }, [select_header_column, source_column_for_display]);

    // Glide gives no clientX/clientY — derive them from the cell bounds plus the
    // in-cell offset. Right-clicking outside the current selection collapses it to
    // the clicked cell (merge-snapped), matching native grid behavior.
    const on_cell_context_menu = useCallback(
        (cell: Item, event: CellClickedEventArgs) => {
            event.preventDefault();
            const [col, row] = cell;
            if (col < 0) {
                const inside = grid_selection_contains_row(grid_selection_ref.current, row);
                const display_rows = inside
                    ? selected_display_row_intervals(grid_selection_ref.current, row_count)
                        ?? [{ start: row, end: row }]
                    : [{ start: row, end: row }];
                if (!inside) {
                    set_grid_selection({
                        columns: CompactSelection.empty(),
                        rows: CompactSelection.fromSingleSelection(row),
                    });
                }
                set_context_menu({
                    kind: 'row',
                    x: event.bounds.x + event.localEventX,
                    y: event.bounds.y + event.localEventY,
                    row,
                    display_rows,
                });
                return;
            }
            const { cell: anchor, range: anchor_range } = expand_glide_selection(
                cell,
                { x: col, y: row, width: 1, height: 1 },
                merges,
            );
            const [anchor_col, anchor_row] = anchor;

            const inside = grid_selection_contains_cell(
                grid_selection_ref.current,
                col,
                row,
            );
            if (!inside) {
                // Use the merge-expanded range so right-clicking any covered cell
                // selects (and highlights) the whole merge block, not just 1x1.
                select_rect(anchor, anchor_range);
            }

            const source_column = source_column_for_display(anchor_col);
            if (source_column === undefined) return;
            set_context_menu({
                kind: 'cell',
                x: event.bounds.x + event.localEventX,
                y: event.bounds.y + event.localEventY,
                row: anchor_row,
                display_col: anchor_col,
                source_col: source_column,
            });
        },
        [merges, row_count, select_rect, source_column_for_display],
    );

    const dismiss_context_menu = useCallback(() => set_context_menu(null), []);

    // Merge-aware keyboard nav. Glide handles plain sheets, range extension, Tab,
    // and Ctrl+A natively; we only intercept where it falls short — arrow keys on
    // merged sheets (it otherwise gets stuck stepping into overlay-covered cells)
    // and hjkl vim nav in view mode. resolve_nav decides; move_active_cell jumps
    // past a merge to its far edge so navigation never stalls.
    const on_key_down = useCallback(
        (args: GridKeyEventArgs) => {
            const shortcut = transform_shortcut({
                shiftKey: args.shiftKey,
                altKey: args.altKey,
                metaKey: args.metaKey,
                ctrlKey: args.ctrlKey,
                key: args.key,
                code: args.rawEvent?.code ?? '',
            });
            if (
                shortcut
                && transform_sections
                && !transform_pending
                && !is_editable_target(args.rawEvent?.target ?? null)
            ) {
                const source_column = focused_source_column_ref.current;
                args.cancel();
                args.preventDefault();
                if (shortcut.kind === 'sort' && source_column !== undefined) {
                    apply_column_sort(source_column, shortcut.direction, false);
                } else if (shortcut.kind === 'clearSorts') {
                    on_transform_change({ ...transform_state, sort: [] });
                } else if (shortcut.kind === 'editFilter' && source_column !== undefined) {
                    const display_column = display_column_for_source(source_column);
                    const bounds = display_column === undefined
                        ? undefined
                        : grid_ref.current?.getBounds(display_column, -1);
                    on_open_filter(
                        source_column,
                        {
                            left: bounds?.x ?? 100,
                            top: bounds ? bounds.y + bounds.height : 100,
                        },
                        () => grid_ref.current?.focus(),
                    );
                } else if (shortcut.kind === 'clearFilter' && source_column !== undefined) {
                    clear_filter_on_column(source_column);
                } else if (shortcut.kind === 'clearFilters') {
                    on_transform_change({ ...transform_state, filters: [] });
                }
                return;
            }
            // Route Ctrl/Cmd+C through the guarded copy path so a large or
            // partly-scrolled selection can't be silently copied as blank cells
            // by Glide's native copy. copy_rect caps the row count and surfaces a
            // warning for non-resident rows. (Header-only selections with no
            // current range fall through to Glide's native copy.)
            if (
                is_copy_key({
                    key: args.key,
                    ctrl: args.ctrlKey,
                    meta: args.metaKey,
                    shift: args.shiftKey,
                    alt: args.altKey,
                })
            ) {
                const selection = grid_selection_ref.current;
                if (selection.columns.length > 0) {
                    const source_columns = Array.from(
                        selection.columns,
                        (display_column) => source_column_for_display(display_column),
                    ).filter((source_column): source_column is number =>
                        source_column !== undefined);
                    args.cancel();
                    args.preventDefault();
                    copy_source_selection({
                        y: 0,
                        height: row_count,
                        source_columns,
                    }, true);
                } else if (selection.rows.length > 0) {
                    args.cancel();
                    args.preventDefault();
                    copy_source_selection({
                        row_indices: selection.rows,
                        row_count: selection.rows.length,
                        source_columns: visible_source_columns,
                    });
                } else if (selection.current) {
                    args.cancel();
                    args.preventDefault();
                    copy_rect(selection.current.range);
                }
                return;
            }
            const decision = resolve_nav({
                key: args.key,
                shift: args.shiftKey,
                ctrl: args.ctrlKey,
                meta: args.metaKey,
                alt: args.altKey,
                editable: editable_cells,
                has_merges: merges.length > 0,
            });
            if (!decision) return;
            const cur = grid_selection_ref.current.current?.cell;
            if (!cur) return;
            if (display_column_count === 0) return;
            const [cur_col, cur_row] = cur;
            const next = move_active_cell(
                cur_row,
                cur_col,
                decision.direction,
                row_count,
                display_column_count,
                merges,
            );
            args.cancel();
            args.preventDefault();
            const { cell, range } = expand_glide_selection(
                [next.col, next.row],
                { x: next.col, y: next.row, width: 1, height: 1 },
                merges,
            );
            focused_source_column_ref.current = source_column_for_display(cell[0]);
            set_grid_selection({
                columns: CompactSelection.empty(),
                rows: CompactSelection.empty(),
                current: { cell, range, rangeStack: [] },
            });
            grid_ref.current?.scrollTo(cell[0], cell[1]);
        },
        [
            apply_column_sort,
            clear_filter_on_column,
            copy_rect,
            copy_source_selection,
            display_column_count,
            display_column_for_source,
            editable_cells,
            merges,
            on_open_filter,
            on_transform_change,
            row_count,
            source_column_for_display,
            transform_pending,
            transform_sections,
            transform_state,
            visible_source_columns,
        ],
    );

    const on_visible_region_changed = useCallback(
        (range: Rectangle) => {
            visible_ref.current = range;
            // Repaint the merge overlay against the live scroll (fires per
            // smooth-scroll frame, so blocks stay pinned to their cells).
            overlay_ref.current?.repaint(range);
            const start = range.y;
            const end = range.y + range.height - 1;
            ensure_rows(start, end);
            const restored_preview = preview_mode && restore_pending_preview_row();
            // While a retained target is waiting for Glide readiness, its remount
            // callback commonly reports row 0. Keep that bootstrap viewport local;
            // the pending sequence is the authoritative preview position.
            if (
                preview_mode
                && !restored_preview
                && !pending_preview_scroll
                && last_preview_row.current !== start
            ) {
                last_preview_row.current = start;
                on_preview_visible_row_change(start);
                vscode_api.postMessage({ type: 'visibleRowChanged', row: start });
            }
        },
        [
            ensure_rows,
            on_preview_visible_row_change,
            pending_preview_scroll,
            preview_mode,
            restore_pending_preview_row,
        ],
    );

    // Kick off the first page before the initial region callback arrives.
    useEffect(() => {
        if (has_visible_columns) ensure_rows(0, 40);
    }, [ensure_rows, has_visible_columns]);

    // Full-region repaint on the discrete events that change content or
    // editability of *every* already-painted cell: a page landing (version
    // bump), the formatting toggle (raw ↔ formatted), and the edit-mode toggle
    // (flips each cell's allowOverlay). A parent re-render alone does not
    // reliably invalidate Glide's per-cell cache, so damage explicitly.
    // (Sheet/merge changes remount via the grid key.)
    useEffect(() => {
        const grid = grid_ref.current;
        if (!grid) return;
        const r = visible_ref.current;
        if (r.width === 0 || r.height === 0) return;
        const cells: { cell: Item }[] = [];
        for (let row = r.y; row < r.y + r.height; row++) {
            const end_column = Math.min(
                r.x + r.width,
                display_column_count,
            );
            for (let col = r.x; col < end_column; col++) {
                cells.push({ cell: [col, row] });
            }
        }
        if (cells.length > 0) grid.updateCells(cells);
    }, [version, show_formatting, editable_cells, display_column_count]);

    // Targeted tint repaint: damage only the cells whose dirty/conflict tint
    // actually changed, not the whole viewport. Single-cell edits/discards
    // already damage their own cell inline; this covers the bulk transitions
    // (save-clear of saved keys, "Discard Conflicted"/"Discard All", and reload
    // drift flipping cells in/out of the conflicted set) without rebuilding
    // every visible cell on each keystroke.
    const prev_dirty_keys_ref = useRef<Set<string>>(new Set());
    const prev_conflicted_keys_ref = useRef<Set<string>>(new Set());
    useEffect(() => {
        const next_dirty = new Set(dirty_cells.keys());
        const changed = changed_tint_keys(
            prev_dirty_keys_ref.current,
            next_dirty,
            prev_conflicted_keys_ref.current,
            conflicted_keys,
        );
        prev_dirty_keys_ref.current = next_dirty;
        // conflicted_keys is a fresh useMemo Set (new identity each change, never
        // mutated in place), so it can be stashed as the snapshot directly — no copy.
        prev_conflicted_keys_ref.current = conflicted_keys;
        const grid = grid_ref.current;
        if (!grid || changed.size === 0) return;
        const r = visible_ref.current;
        const cells: { cell: Item }[] = [];
        for (const key of changed) {
            const [row, source_column] = key.split(':').map(Number);
            const display_column = display_column_for_source(source_column);
            if (
                display_column !== undefined &&
                display_column >= r.x &&
                display_column < r.x + r.width &&
                row >= r.y &&
                row < r.y + r.height
            ) {
                cells.push({ cell: [display_column, row] });
            }
        }
        if (cells.length > 0) grid.updateCells(cells);
    }, [dirty_cells, conflicted_keys, display_column_for_source]);

    const previous_highlights_ref = useRef<SheetCellHighlightState['cells']>();
    const [highlight_version, set_highlight_version] = useState(0);
    useEffect(() => {
        const previous = previous_highlights_ref.current;
        const next = cell_highlights?.cells;
        previous_highlights_ref.current = next;
        const changed = changed_highlight_keys(previous, next);
        if (changed.size === 0) return;
        // Drives MergeOverlay's bounds-retry effect so highlight changes that
        // land before Glide's first draw still paint (the one-shot repaint()
        // below can lose that race).
        set_highlight_version((n) => n + 1);
        const cells = visible_highlight_damage(
            changed,
            visible_ref.current,
            display_column_for_source,
            get_source_row,
        ).map(({ cell }) => ({ cell: cell as Item }));
        if (cells.length > 0) grid_ref.current?.updateCells(cells);
        // A vertical merge can remain visible while its anchor row is above the
        // viewport, so anchor-key changes are not guaranteed to produce cell damage.
        if (merge_index.entries.some((entry) => entry.rowSpan > 1)) {
            overlay_ref.current?.repaint();
        }
    }, [
        cell_highlights,
        display_column_for_source,
        get_source_row,
        merge_index,
    ]);

    const handle_column_resize = useCallback(
        (_column: GridColumn, new_size: number, display_column: number) => {
            const source_column = source_column_for_display(display_column);
            if (source_column !== undefined) {
                on_column_resize(source_column, new_size);
            }
        },
        [on_column_resize, source_column_for_display],
    );

    // Snapshot the cell menu's effective selection while rendering so every model
    // callback targets the same rows and range that supplied its labels.
    let cell_menu_items = null;
    if (context_menu?.kind === 'cell') {
        const { row, display_col, source_col } = context_menu;
        const range = grid_selection.current?.range;
        const selected_rows = selected_display_row_intervals(grid_selection, row_count);
        const selected_row_count = selected_rows?.reduce(
            (total, interval) => total + interval.end - interval.start + 1,
            0,
        ) ?? 1;
        const highlight_selection = current_highlight_selection();
        const highlight_cell_count = highlight_selection
            ? highlight_selection.displayRows.reduce(
                (total, interval) => total + interval.end - interval.start + 1,
                0,
            ) * highlight_selection.sourceColumns.length
            : 0;
        cell_menu_items = cell_context_menu_items({
            dirty: dirty_cells.has(`${row}:${source_col}`),
            is_multi_cell: !!range && range.width * range.height > 1,
            preview_mode,
            can_hide_rows: !!selected_rows
                && transform_sections
                && !transform_pending
                && !edit_mode
                && !preview_mode,
            selected_row_count,
            can_clear_highlight: highlight_selection_may_have_renderable_highlight(
                highlight_selection,
                cell_highlights?.cells,
                get_source_row,
            ),
            highlight_cell_count,
            on_discard_edit: () => discard_edit(row, display_col, source_col),
            on_copy_cell: () => copy_rect({
                x: display_col,
                y: row,
                width: 1,
                height: 1,
            }),
            on_copy_selection: () => {
                if (range) copy_rect(range);
            },
            on_highlight: (color) => mutate_highlight_selection({ type: 'set', color }),
            on_clear_highlight: () => mutate_highlight_selection({ type: 'clear' }),
            on_hide_rows: () => {
                if (selected_rows) on_hide_rows(selected_rows);
            },
            on_hide_column: () => hide_source_column(source_col),
            on_select_row: () => select_row(row),
            on_select_column: () => select_column(display_col),
            on_select_all: select_all,
        });
    }

    if (!has_visible_columns) {
        return (
            <div ref={grid_root_ref} className="grid-shell-root">
                <div className="all-columns-hidden" role="status">
                    {sheet_meta.columnCount === 0
                        ? 'This sheet contains no columns.'
                        : 'All columns are hidden. Show one or more columns to resume the table.'}
                </div>
            </div>
        );
    }

    return (
        <div ref={grid_root_ref} className="grid-shell-root">
            <DataEditor
                ref={grid_ref}
                className="glide-grid"
                width="100%"
                height="100%"
                rows={row_count}
                columns={columns}
                getCellContent={get_cell_content}
                rowHeight={get_row_height}
                rowMarkers="number"
                theme={theme}
                smoothScrollX
                smoothScrollY
                getCellsForSelection={true}
                gridSelection={grid_selection}
                onGridSelectionChange={on_grid_selection_change}
                drawHeader={draw_header}
                onHeaderClicked={focus_header_column}
                onHeaderContextMenu={on_header_context_menu}
                onVisibleRegionChanged={on_visible_region_changed}
                onColumnResize={handle_column_resize}
                onItemHovered={on_item_hovered}
                onCellEdited={on_cell_edited}
                onCellContextMenu={on_cell_context_menu}
                onKeyDown={on_key_down}
                provideEditor={provide_editor}
            />
            <MergeOverlay
                ref={overlay_ref}
                grid_ref={grid_ref}
                merge_index={merge_index}
                theme={theme}
                show_formatting={show_formatting}
                get_row={get_row}
                get_source_row={get_source_row}
                get_cell_background={get_highlight_background}
                version={version}
                highlight_version={highlight_version}
            />
            {!transformed && (
                <RowResizeOverlay
                    ref={row_resize_ref}
                    on_resize={handle_row_resize_drag}
                />
            )}
            {context_menu?.kind === 'cell' && (
                <ContextMenu
                    x={context_menu.x}
                    y={context_menu.y}
                    items={cell_menu_items ?? []}
                    on_dismiss={dismiss_context_menu}
                    restore_focus={() => grid_ref.current?.focus()}
                />
            )}
            {context_menu?.kind === 'row' && (() => {
                const selected_row_count = context_menu.display_rows.reduce(
                    (total, interval) => total + interval.end - interval.start + 1,
                    0,
                );
                return (
                    <ContextMenu
                        x={context_menu.x}
                        y={context_menu.y}
                        aria_label={selected_row_count === 1
                            ? `Row actions for row ${context_menu.row + 1}`
                            : `Row actions for ${selected_row_count} selected rows`}
                        items={row_context_menu_items({
                            selected_row_count,
                            can_hide_rows: transform_sections
                                && !transform_pending
                                && !edit_mode
                                && !preview_mode,
                            on_hide_rows: () => on_hide_rows(context_menu.display_rows),
                            on_copy_rows: () => copy_display_rows(context_menu.display_rows),
                        })}
                        on_dismiss={dismiss_context_menu}
                        restore_focus={() => grid_ref.current?.focus()}
                    />
                );
            })()}
            {context_menu?.kind === 'multi-column' && (
                <MultiColumnContextMenu
                    x={context_menu.x}
                    y={context_menu.y}
                    column_count={context_menu.source_cols.length}
                    transform_sections={transform_sections}
                    transform_disabled={transform_pending}
                    on_copy={() => copy_source_selection({
                        y: 0,
                        height: row_count,
                        source_columns: context_menu.source_cols,
                    }, true)}
                    on_hide={() => hide_source_columns_multi(context_menu.source_cols)}
                    on_sort={(direction) =>
                        apply_multi_column_sort(context_menu.source_cols, direction)}
                    on_dismiss={dismiss_context_menu}
                    restore_focus={() => {
                        if (!suppress_menu_restore_ref.current) {
                            grid_ref.current?.focus();
                        }
                    }}
                />
            )}
            {context_menu?.kind === 'header' && (() => {
                const source_column = context_menu.source_col;
                const active_sort = transform_state.sort.find((key) =>
                    key.colIndex === source_column);
                const existing_filter = transform_state.filters.find((entry) =>
                    entry.colIndex === source_column);
                return (
                    <ColumnContextMenu
                        x={context_menu.x}
                        y={context_menu.y}
                        column_name={columns[context_menu.display_col]?.title
                            ?? `Column ${source_column + 1}`}
                        transform_sections={transform_sections}
                        transform_disabled={transform_pending}
                        active_direction={active_sort?.direction ?? null}
                        any_sorted={transform_state.sort.length > 0}
                        other_columns_sorted={transform_state.sort.some((key) =>
                            key.colIndex !== source_column)}
                        has_filter={existing_filter !== undefined}
                        any_filtered={transform_state.filters.length > 0}
                        on_copy={() => copy_rect({
                            x: context_menu.display_col,
                            y: 0,
                            width: 1,
                            height: row_count,
                        }, true)}
                        on_hide={() => hide_source_column(source_column)}
                        on_sort={(direction, append) =>
                            apply_column_sort(source_column, direction, append)}
                        on_clear_column_sort={() => on_transform_change({
                            ...transform_state,
                            sort: transform_state.sort.filter((key) =>
                                key.colIndex !== source_column),
                        })}
                        on_clear_all_sorts={() => on_transform_change({
                            ...transform_state,
                            sort: [],
                        })}
                        on_edit_filter={() => {
                            suppress_menu_restore_ref.current = true;
                            on_open_filter(
                                source_column,
                                { left: context_menu.x, top: context_menu.y },
                                () => grid_ref.current?.focus(),
                            );
                        }}
                        on_clear_column_filter={() => clear_filter_on_column(source_column)}
                        on_clear_all_filters={() => on_transform_change({
                            ...transform_state,
                            filters: [],
                        })}
                        on_dismiss={dismiss_context_menu}
                        restore_focus={() => {
                            if (!suppress_menu_restore_ref.current) {
                                grid_ref.current?.focus();
                            }
                        }}
                    />
                );
            })()}
        </div>
    );
}
