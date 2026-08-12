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
import {
    column_projections_equal,
    type ColumnProjection,
} from './column-projection';
import { build_grid_columns } from './grid-model';
import { ContextMenu } from './context-menu';
import { cell_context_menu_items } from './cell-context-menu';
import { ColumnContextMenu, MultiColumnContextMenu } from './column-context-menu';
import {
    grid_selection_contains_column,
    header_drag_columns,
    header_drag_state_for_selection,
    selected_display_columns,
    selected_source_columns,
    type HeaderDragState,
} from './column-selection-model';
import { row_context_menu_items } from './row-context-menu';
import { use_row_marker_selection } from './use-row-marker-selection';
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
    DEFAULT_MAX_ROWS,
} from './grid-copy-model';
import {
    resolve_nav,
    is_copy_key,
    move_sequential_cell,
} from './grid-nav-model';
import { move_active_cell } from './selection';
import { MergeIndex } from './merge-index';
import { build_grid_cell, type CellEditOverlay } from './cell-renderer';
import {
    CELL_TOOLTIP_SHOW_DELAY_MS,
    cell_tooltip_position,
    clamp_tooltip_text,
    text_overflows_cell,
} from './cell-overflow-model';
import { use_editing, type DirtyEntry } from './use-editing';
import {
    create_edit_session_store,
    type EditSessionStore,
} from './edit-session-store';
import type { LiveEdit } from './csv-save-model';
import {
    csv_save_operations_equal,
    resolve_csv_save_hydration,
    save_operation_worksheet,
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
    visible_source_key_damage,
} from './grid-repaint-model';
import { expand_glide_selection } from './selection-glide';
import {
    grid_selection_contains_cell,
    highlight_selection_may_have_renderable_highlight,
    highlight_selection_from_grid,
    selected_display_row_intervals,
} from './highlight-selection-model';
import { highlight_rgba } from './highlight-theme';
import {
    clamp_row_height,
    default_row_height_for_font,
    line_height_for_font,
    natural_row_height,
    resolved_row_height,
    type RowHeightLayer,
    type RowHeightOverrides,
} from './row-heights';

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

import { use_row_loader } from './use-row-loader';
import { theme_font_size_px, use_vscode_theme } from './vscode-theme';
import { host_bridge, pending_edit_durability } from './host-bridge';
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
    /** Fold this sheet's live editor, then ask App to atomically save the workbook. */
    request_save(): boolean;
    /** Drop every dirty edit. */
    clear_dirty(): void;
    /** Drop only edits whose underlying cell drifted (conflict resolution). */
    discard_conflicted(): void;
    /**
     * Drop exactly the named source-keyed edits. Separate from
     * {@link discard_conflicted}, whose meaning is defined by
     * `is_entry_conflicted` and is therefore residency-gated: the keys the *host*
     * names on a rejected save are precisely the ones that predicate cannot see
     * (a filtered-out row, an evicted page, a row past the row count), so
     * overloading it would leave the blocking entry in place.
     */
    discard_keys(keys: readonly string[]): void;
    /** Fence every renderer-side mutation before a host close/reload flush. */
    stop_edit_admission(): void;
    /** Snapshot the current Glide overlay into the source-keyed dirty map. */
    commit_live_edit(): void;
    /** Commit the overlay and synchronously publish this worksheet's complete map. */
    flush_live_edit(): void;
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

export interface GridActionsHandle {
    /** Sheet this handle's grid is mounted for; guards stale-remount races. */
    sheet_index: number;
    select_all(): void;
    /** Loads the sheet's rows before serializing, so it resolves asynchronously. */
    copy_sheet(): Promise<void>;
    /** Copy the current cell selection as TSV, mirroring Glide's own Ctrl+C.
     *  No-op when nothing is selected. */
    copy_selection(): void;
}

export interface PendingPreviewScroll {
    row: number;
    sequence: number;
}

interface RowResizePreview {
    row: number;
    /** Full selection materialized once when the drag finishes. */
    commit_rows: GridSelection['rows'] | null;
    /** Live preview selection. Like Glide columns, only active from its first row. */
    preview_rows: GridSelection['rows'] | null;
    start_height: number;
    height: number;
}

export interface GridShellProps {
    sheet_meta: SheetMeta;
    sheet_index: number;
    generation: number;
    /**
     * Effective displayed row count (may be filtered).
     *
     * There is deliberately no `transformed` beside it any more, and the absence is worth
     * a sentence. The shell used to be told whether its display rows were a permutation
     * of source rows, and its three readers were all row-height suppressions — the resize
     * overlay's mount, hover-arming, multiline auto-grow. All three are gone: durable
     * heights are keyed by canonical source row and arrive already projected into display
     * space, so a permuted view is no different here from an unpermuted one. The merge
     * flattening the flag was also cited for is decided in App, which simply passes
     * `merges` empty. Nothing in a shell that reads a display-keyed projection and posts
     * display intervals needs to know which it is looking at; a future guard that thinks
     * it does is a display→source mapping trying to grow a second home.
     */
    row_count?: number;
    show_formatting: boolean;
    column_projection: ColumnProjection;
    /** Persisted widths keyed by canonical source column. */
    column_widths: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    /**
     * Heights keyed by *display* row: the host's projection of the durable
     * source-keyed map into the coordinate space of the view currently installed. So
     * it is safe to read at a display row under any permutation, which is what makes
     * the row-resize affordances below unconditional.
     */
    row_heights: RowHeightOverrides;
    /**
     * Resizes committed here but not yet reflected in `row_heights`, newest last.
     * App owns their lifetime (they are void once the view generation moves); this
     * shell only reads them, over `row_heights`, via `resolved_row_height`.
     */
    row_height_overlay?: readonly RowHeightLayer[];
    /**
     * A completed resize, as the inclusive display-row intervals it named. Intervals
     * rather than an expanded row list because the committed rows are the user's whole
     * row selection, which can be select-all; and display rows rather than source rows
     * because the host is the only party that can map them — for a select-all those
     * rows were never loaded here. See the `setRowHeights` message.
     */
    on_row_resize: (rows: readonly DisplayRowInterval[], height: number) => void;
    merges: MergeRange[];
    preview_mode?: boolean;
    // Editing (Phase E). edit_mode is App-controlled (toolbar toggle); editing is
    // only possible when csv_editable.
    edit_mode?: boolean;
    csv_editable?: boolean;
    edit_session_id?: string;
    /** App-owned operation survives generation-keyed GridShell remounts. */
    save_operation?: CsvSaveOperation;
    save_lifecycle?: CsvSaveLifecycle;
    /** App owns workbook-wide operation construction and host posting. */
    on_save_request?: () => CsvSaveOperation | undefined;
    initial_edits?: Record<string, string | DirtyEntry>;
    /**
     * App-owned dirty map. Its lifetime is the edit session, so committed edits
     * outlive this generation-keyed mount; without it the shell falls back to a
     * mount-scoped store seeded from `initial_edits`.
     */
    edit_session?: EditSessionStore;
    /**
     * Source-keyed keys the host refused the last save over. Unioned into the
     * conflict tint so a `baseMismatch` cell is visibly marked even though the
     * webview's own residency-gated conflict detection cannot flag it. A
     * `rowsRemoved` key has no cell to tint (its row is past `row_count`), which is
     * why the banner names its row numbers instead.
     */
    host_rejected_keys?: readonly string[];
    on_editing_change?: (status: EditingStatus) => void;
    // App provides this ref; GridShell populates it with imperative save/discard
    // actions so App's toolbar + conflict banner can drive editing that lives here.
    editing_ref?: MutableRefObject<EditingHandle | null>;
    // App provides this ref; GridShell populates it with a function that measures
    // loaded rows and returns fitted column widths (null when nothing is loaded).
    auto_fit_ref?: MutableRefObject<(() => Record<number, number> | null) | null>;
    /** App-owned bridge for restoring focus after generation-keyed remounts. */
    grid_focus_ref?: MutableRefObject<GridFocusHandle | null>;
    /** App-owned bridge for sheet-tab actions (select all / copy sheet). */
    grid_actions_ref?: MutableRefObject<GridActionsHandle | null>;
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
    can_promote_row_to_header?: boolean;
    on_promote_row_to_header?: (display_row: number) => void;
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
    show_formatting,
    column_projection,
    column_widths,
    on_column_resize,
    row_heights,
    row_height_overlay,
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
    edit_session,
    host_rejected_keys,
    on_editing_change,
    editing_ref,
    auto_fit_ref,
    grid_focus_ref,
    grid_actions_ref,
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
    can_promote_row_to_header = false,
    on_promote_row_to_header = () => {},
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
    const {
        theme,
        highContrast: high_contrast,
        dirtyBg: dirty_bg,
        conflictBg: conflict_bg,
    } = use_vscode_theme();
    // The configured font size, resolved once from the theme so cell painting,
    // canvas measurement, and default row heights all agree.
    const font_size_px = theme_font_size_px(theme);
    const default_row_height = default_row_height_for_font(font_size_px);
    const grid_ref = useRef<DataEditorRef | null>(null);
    const grid_root_ref = useRef<HTMLDivElement | null>(null);
    const overlay_ref = useRef<MergeOverlayHandle | null>(null);
    const row_resize_ref = useRef<RowResizeOverlayHandle | null>(null);
    const row_resize_preview_ref = useRef<RowResizePreview | null>(null);
    const [row_resize_preview, set_row_resize_preview] =
        useState<RowResizePreview | null>(null);
    const visible_ref = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 });
    const last_preview_row = useRef<number | null>(null);
    const applied_preview_sequence_ref = useRef<number | null>(null);
    const preview_restore_not_before_ref = useRef(0);
    const preview_restore_timer_ref = useRef<number | null>(null);
    const preview_restore_token_ref = useRef(0);

    const focus_grid = useCallback((): boolean => {
        // Glide's ref can exist before its internal focus target is wired after a
        // remount. Prefer the mounted tabbable element itself.
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
    }, []);

    useLayoutEffect(() => {
        if (!grid_focus_ref) return;
        const handle: GridFocusHandle = {
            generation,
            focus: focus_grid,
        };
        grid_focus_ref.current = handle;
        return () => {
            if (grid_focus_ref.current === handle) grid_focus_ref.current = null;
        };
    }, [focus_grid, generation, grid_focus_ref, has_visible_columns]);

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

    const {
        ensure_rows,
        ensure_rows_loaded,
        pin_rows,
        unpin_rows,
        get_row,
        get_source_row,
        get_cell_raw_for_source,
        sample_loaded_rows,
        version,
    } = loader;
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
    const worksheet_payload = useCallback((operation: CsvSaveOperation | undefined) =>
        operation && save_operation_worksheet(
            operation,
            sheet_index,
            sheet_meta.name,
            sheet_meta.worksheetId,
        ), [sheet_index, sheet_meta.name, sheet_meta.worksheetId]);
    const restored_worksheet = worksheet_payload(restored_save_operation);
    // Fallback for a consumer that doesn't hoist the session store (the shell's
    // own tests). Lazy so `resolve_csv_save_hydration` runs once at store
    // creation rather than on every render; its live job is session filtering at
    // mount, which grid-shell-save.test.ts covers.
    const fallback_store_ref = useRef<EditSessionStore | null>(null);
    if (edit_session === undefined && fallback_store_ref.current === null) {
        fallback_store_ref.current = create_edit_session_store(
            { session_id: edit_session_id },
            resolve_csv_save_hydration(
                { authoritative: save_lifecycle, operation: save_operation },
                edit_session_id,
                sheet_index,
                sheet_meta.name,
                sheet_meta.worksheetId,
                initial_edits,
            ),
        );
    }
    const store = edit_session ?? fallback_store_ref.current!;
    // Values posted in the in-flight save; edit bases use these before reload.
    const saved_edits_ref = useRef<Record<string, string>>(
        restored_worksheet ? { ...restored_worksheet.edits } : {},
    );
    const save_operation_ref = useRef<CsvSaveOperation | undefined>(
        restored_save_operation,
    );
    const save_in_flight_ref = useRef(restored_save_operation !== undefined);
    const close_barrier_ref = useRef(false);
    const [close_barrier_active, set_close_barrier_active] = useState(false);
    const close_barrier_session_ref = useRef(edit_session_id);
    if (close_barrier_session_ref.current !== edit_session_id) {
        // A close/release fence belongs to one edit session. A later grant can reuse
        // this mounted GridShell, so reopen the synchronous mutation boundary during
        // render rather than leaving the new session permanently read-only.
        close_barrier_session_ref.current = edit_session_id;
        close_barrier_ref.current = false;
    }
    useEffect(() => {
        set_close_barrier_active(false);
    }, [edit_session_id]);

    // Read a cell's persisted raw text from the paged cache for the editing hook.
    // Stabilized against the loader's per-render callback identities; `version` in
    // the deps makes conflict detection re-run as freshly-loaded pages arrive.
    // `get_row_ref` is still the copy path's reader (display-keyed, by design).
    const get_row_ref = useRef(get_row);
    get_row_ref.current = get_row;
    const get_cell_raw_for_source_ref = useRef(get_cell_raw_for_source);
    get_cell_raw_for_source_ref.current = get_cell_raw_for_source;
    // First parameter is a **canonical source row**, not a display row: durable
    // edit keys are source-keyed, and the store hands the row component of a key
    // straight to this reader (is_entry_conflicted / resolve_pending_bases).
    //
    // The `saved_edits_ref` lookup below is the subtle part. Those keys come from
    // the in-flight save operation's edits, which are source-keyed after this PR,
    // so the lookup lines up automatically — *but only because this row parameter
    // is now a source row too*. A display-keyed reader over a source-keyed store
    // would type-check, compile, and miss on every permuted row, silently
    // comparing conflicts against the wrong base.
    const get_cell_raw = useCallback(
        (source_row: number, c: number): string | undefined => {
            const saved = saved_edits_ref.current[`${source_row}:${c}`];
            if (saved !== undefined) return saved;
            // Source row not resident (evicted, not yet fetched, or filtered out of
            // the current view): undefined so conflict detection treats it as
            // unknown, never as a changed value.
            return get_cell_raw_for_source_ref.current(source_row, c);
        },
        [version],
    );

    const {
        dirty_cells,
        conflicted_keys: derived_conflicted_keys,
        commit_edit,
        clear_dirty,
        replace_dirty,
        clear_dirty_keys,
        discard_conflicted,
    } = use_editing(get_cell_raw, generation, edit_session_id, store);

    // Tint set = what the webview can derive ∪ what the host named. The union is
    // what everything downstream consumes (the paint callback's ref, the targeted
    // repaint effect's diff, and the status reported to App), so a host-named cell
    // is marked and un-marked by exactly the same machinery as a derived one. Only
    // keys the store actually holds are included: a stale rejection naming an
    // already-discarded edit must not keep tinting, and `dirty_cells` is what
    // decides whether a cell is painted with an overlay at all.
    //
    // `conflicted` reported up to App stays this union too. That is deliberate: a
    // host-named mismatch *is* a conflict from the user's point of view, and the
    // alternative (App reconciling two sets) would put the same union in two places.
    const conflicted_keys = useMemo(() => {
        if (!host_rejected_keys || host_rejected_keys.length === 0) {
            return derived_conflicted_keys;
        }
        const union = new Set(derived_conflicted_keys);
        for (const key of host_rejected_keys) {
            if (dirty_cells.has(key)) union.add(key);
        }
        return union;
    }, [derived_conflicted_keys, host_rejected_keys, dirty_cells]);
    const applied_save_lifecycle_revision_ref = useRef(save_lifecycle.revision);
    const [save_in_flight, set_save_in_flight] = useState(
        restored_save_operation !== undefined,
    );
    const editable_cells = edit_mode
        && csv_editable
        && !save_in_flight
        && !close_barrier_active;

    useEffect(() => {
        if (
            !save_operation
            || save_operation.editSessionId !== edit_session_id
            || csv_save_operations_equal(save_operation_ref.current, save_operation)
        ) return;
        const worksheet = worksheet_payload(save_operation);
        if (!worksheet) return;
        save_operation_ref.current = save_operation;
        saved_edits_ref.current = { ...worksheet.edits };
        save_in_flight_ref.current = true;
        set_save_in_flight(true);
    }, [edit_session_id, save_operation, worksheet_payload]);

    const apply_save_lifecycle = useCallback((lifecycle: CsvSaveLifecycle) => {
        if (lifecycle.revision <= applied_save_lifecycle_revision_ref.current) return;
        applied_save_lifecycle_revision_ref.current = lifecycle.revision;
        if (lifecycle.state === 'active') {
            const operation = lifecycle.operation;
            if (operation.editSessionId !== edit_session_id) return;
            const locked = save_operation_ref.current;
            if (locked && !csv_save_operations_equal(locked, operation)) return;
            const worksheet = worksheet_payload(operation);
            if (!worksheet) return;
            save_operation_ref.current = operation;
            saved_edits_ref.current = { ...worksheet.edits };
            replace_dirty(worksheet.dirtyEdits);
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
            sheet_index,
            sheet_meta.name,
            sheet_meta.worksheetId,
            Object.fromEntries(store.snapshot()),
        ) ?? {}) as CsvDirtyMap;
        replace_dirty(restore);
        save_operation_ref.current = undefined;
        saved_edits_ref.current = {};
        save_in_flight_ref.current = false;
        set_save_in_flight(false);
    }, [
        edit_session_id,
        replace_dirty,
        sheet_index,
        sheet_meta.name,
        sheet_meta.worksheetId,
        store,
        worksheet_payload,
    ]);

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

    // Last payload actually posted, per session. Guards against re-posting a map
    // the host already holds — which is not merely wasted work, because the host
    // reads *any* pendingEditsChanged as "the user moved on from the failed save":
    // it clears `failedSaveTombstone` and retires the `failed` lifecycle. A failed
    // save re-installs the session store, and install force-notifies across the
    // hydration boundary, so the effect below re-runs with the failed operation's
    // *own* map. Echoing that back would satisfy the host's "unused shared state"
    // predicate with the cleanup obligation unmet, and the failed edits would
    // survive into the next edit session. Keying on the session id as well as the
    // payload keeps a freshly granted session from being stranded with a map the
    // host recorded under the previous one.
    const post_pending_edits = useCallback((
        edits: Record<string, DirtyEntry> | null,
        force = false,
    ): number => {
        if (!edit_session_id) return 0;
        if (close_barrier_ref.current) {
            return pending_edit_durability.snapshot(edit_session_id)
                .highestProducedSequence;
        }
        // This shell's own sheet, index and name both: the session is
        // workbook-scoped, so the post names the slot it is a complete map of,
        // and the name lets the host follow the sheet through a reorder that
        // lands while the write is queued.
        return pending_edit_durability.publish(
            edit_session_id,
            edits,
            sheet_index,
            sheet_meta.name,
            force,
            sheet_meta.worksheetId,
        );
    }, [edit_session_id, sheet_index, sheet_meta.name, sheet_meta.worksheetId]);

    // Persist a complete dirty map under a renderer-monotonic sequence. The host
    // acknowledges only after the corresponding state-store write resolves.
    useEffect(() => {
        if (!edit_mode || !edit_session_id || save_in_flight_ref.current) return;
        post_pending_edits(
            dirty_cells.size > 0 ? Object.fromEntries(dirty_cells) : null,
        );
    }, [dirty_cells, edit_mode, edit_session_id, post_pending_edits, save_in_flight]);

    // Mirror read imperatively by the save handle (which must stay stable so the
    // ref App holds doesn't churn): the current selection. The dirty map needs no
    // mirror — `store` is a stable handle whose reads are always current, so it
    // sits in a dep array without churning.
    // get_cell_content reads dirty/conflict state through `store` and the ref
    // below, never through the subscribed `dirty_cells`, so its identity stays
    // stable across edits — otherwise every commit would rebuild the closure and
    // invalidate Glide's whole per-cell cache. Targeted repaints (below) drive the
    // actual damage instead.
    // conflicted_keys still needs a mirror: it is derived (in the hook from
    // get_cell_raw, then unioned with the host's rejected keys above) rather than
    // stored, so there is nothing stable to read it from.
    const conflicted_keys_ref = useRef(conflicted_keys);
    conflicted_keys_ref.current = conflicted_keys;
    const grid_selection_ref = useRef(grid_selection);
    grid_selection_ref.current = grid_selection;
    // Populated once the truncated-cell tooltip helpers mount below; row menus
    // open from an earlier hook, so they clear via this ref rather than a TDZ.
    const hide_cell_tooltip_ref = useRef<() => void>(() => {});
    const open_row_marker_menu = useCallback((request: {
        x: number;
        y: number;
        row: number;
        display_rows: DisplayRowInterval[];
    }) => {
        hide_cell_tooltip_ref.current();
        set_context_menu({ kind: 'row', ...request });
    }, []);
    const row_markers = use_row_marker_selection({
        row_count,
        selection_ref: grid_selection_ref,
        set_selection: set_grid_selection,
        on_open_menu: open_row_marker_menu,
    });
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
    const write_grid_selection = useCallback((selection: GridSelection) => {
        if (selection.current) {
            focused_source_column_ref.current = source_column_for_display(
                selection.current.cell[0],
            );
        }
        grid_selection_ref.current = selection;
        set_grid_selection(selection);
    }, [source_column_for_display]);
    const select_active_display_cell = useCallback((target: Item) => {
        const { cell, range } = expand_glide_selection(
            target,
            { x: target[0], y: target[1], width: 1, height: 1 },
            merges,
        );
        const selection: GridSelection = {
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: { cell, range, rangeStack: [] },
        };
        write_grid_selection(selection);
        grid_ref.current?.scrollTo(cell[0], cell[1]);
    }, [merges, write_grid_selection]);
    const select_active_display_cell_ref = useRef(select_active_display_cell);
    const focus_grid_ref = useRef(focus_grid);
    const row_count_ref = useRef(row_count);
    const display_column_count_ref = useRef(display_column_count);
    useLayoutEffect(() => {
        select_active_display_cell_ref.current = select_active_display_cell;
        focus_grid_ref.current = focus_grid;
        row_count_ref.current = row_count;
        display_column_count_ref.current = display_column_count;
    }, [
        select_active_display_cell,
        focus_grid,
        row_count,
        display_column_count,
    ]);
    const previous_projection_ref = useRef(column_projection);
    useEffect(() => {
        if (column_projections_equal(previous_projection_ref.current, column_projection)) {
            previous_projection_ref.current = column_projection;
            return;
        }
        previous_projection_ref.current = column_projection;
        const focused_source = focused_source_column_ref.current;
        focused_source_column_ref.current = focused_source !== undefined
            && visible_source_columns.includes(focused_source)
            ? focused_source
            : visible_source_columns[0];
        write_grid_selection({
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
    }, [column_projection, display_column_count, visible_source_columns, write_grid_selection]);

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

    // --- Open-overlay identity capture + page pin -----------------------------
    // Durable edit identity has a *lifetime*, not an instant: the user opens an
    // overlay on display row 12, types, and only later presses Enter. Between
    // those two moments the page holding row 12 can leave — Glide's overlay does
    // not close on scroll (its ClickOutsideContainer listens for pointer events
    // only), and every page that lands while scrolling away runs `evict`, whose
    // protect set is the current viewport plus in-flight bulk copies. Nothing
    // there covers the row under an open editor.
    //
    // Re-deriving the source row at commit time therefore yields `undefined` for a
    // row that was perfectly resolvable when the overlay opened, and the commit
    // guards would discard text the user typed and watched appear — the exact
    // failure the overlay-open gate exists to prevent, arrived at from the other
    // side. So resolve identity once, when the overlay mounts, and hold it:
    //
    //  - capture: the commit falls back to the identity the overlay opened with,
    //    which keeps the typed text even if the page is already gone;
    //  - pin: the page stays resident, so `get_cell_raw` can still read the
    //    entry's conflict base (capture alone cannot supply that).
    //
    // Both are needed. The pin alone still loses the row across a sheet switch or
    // reload (which clear the cache outright); the capture alone leaves the base
    // unreadable.
    const open_overlay_row_ref = useRef<{
        display_cell: Item;
        source_row: number;
        pin: symbol;
    } | null>(null);
    const pending_editor_navigation_ref = useRef<Item | null>(null);
    useEffect(() => {
        pending_editor_navigation_ref.current = null;
    }, [column_projection, generation]);
    // Stable handles so the tracking editor's memo identity never churns: Glide
    // remounts (and unfocuses) the overlay editor whenever the component identity
    // changes, which would defeat the very capture below.
    const pin_rows_ref = useRef(pin_rows);
    pin_rows_ref.current = pin_rows;
    const unpin_rows_ref = useRef(unpin_rows);
    unpin_rows_ref.current = unpin_rows;
    const get_source_row_ref = useRef(get_source_row);
    get_source_row_ref.current = get_source_row;

    const release_open_overlay_row = useCallback(() => {
        const captured = open_overlay_row_ref.current;
        if (!captured) return;
        open_overlay_row_ref.current = null;
        unpin_rows_ref.current(captured.pin);
    }, []);

    const capture_open_overlay_row = useCallback(() => {
        // Defensive: an overlay opening while a previous capture is still live
        // would otherwise strand that pin forever, permanently shrinking the LRU
        // cap. Glide only ever has one overlay open, so this is belt and braces.
        release_open_overlay_row();
        const loc = grid_selection_ref.current.current?.cell;
        if (!loc) return;
        const display_row = loc[1];
        const source_row = get_source_row_ref.current(display_row);
        // Unresolved identity: nothing to remember and nothing worth pinning. The
        // overlay-open gate means this is unreachable for a real editor mount, and
        // leaving the ref null keeps the commit guards' early return intact.
        if (source_row === undefined) return;
        open_overlay_row_ref.current = {
            display_cell: [loc[0], display_row],
            source_row,
            pin: pin_rows_ref.current(display_row, display_row),
        };
    }, [release_open_overlay_row]);

    /**
     * Canonical source row for a commit arriving from the open overlay. Live
     * residency first — that is the truth for every path that did not come through
     * an overlay (Glide's paste path, most importantly, which never opens one).
     * Only when the row is no longer resident does the identity captured at
     * overlay-open time stand in, and only for the row it was captured for: a
     * mismatched display row means this commit is not that overlay's, so the
     * caller's early return still applies.
     */
    const commit_source_row = useCallback((row: number): number | undefined => {
        const resident = get_source_row(row);
        if (resident !== undefined) return resident;
        const captured = open_overlay_row_ref.current;
        return captured !== null && captured.display_cell[1] === row
            ? captured.source_row
            : undefined;
    }, [get_source_row]);

    // Leaving edit mode (or a save taking the grid read-only) makes provide_editor
    // stop supplying an editor, which unmounts it and runs the cleanup below — but
    // only if Glide re-renders the overlay. Releasing here too makes the lifecycle
    // independent of that: an unreleased pin would hold a page resident for the
    // rest of the session.
    useEffect(() => {
        if (editable_cells) return;
        pending_editor_navigation_ref.current = null;
        release_open_overlay_row();
    }, [editable_cells, release_open_overlay_row]);

    // Unmount (a generation/sheet remount, or the webview closing). The loader's
    // own unmount clears its pins as well, so this is the belt to that braces —
    // kept because the two are separate objects and only this one knows the ref.
    useEffect(() => release_open_overlay_row, [release_open_overlay_row]);

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
        // The `key` is a durable edit key, so it must be fully source-keyed: the
        // save collectors (collect_save_edits / collect_exact_dirty_edits) merge it
        // straight into the source-keyed dirty map, and a display-keyed LiveEdit
        // would poison them. Falls back to the identity captured when this overlay
        // opened, so an editor whose page left mid-edit still reaches the save
        // rather than being silently dropped (see commit_source_row).
        const source_row = commit_source_row(row);
        if (source_row === undefined) return null;
        return {
            key: `${source_row}:${source_column}`,
            value,
            original: get_cell_raw(source_row, source_column) ?? '',
        };
    }, [commit_source_row, get_cell_raw, source_column_for_display]);

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

    // Fold this sheet's live editor, then let App snapshot every dirty worksheet
    // and post one atomic workbook operation. GridShell never assembles a partial
    // operation: the registry and operation identity both live above this mount.
    const request_save = useCallback((): boolean => {
        if (close_barrier_ref.current || save_in_flight_ref.current || !edit_session_id) {
            return false;
        }
        const live = read_live_edit();
        if (live) {
            const [source_row, source_column] = live.key.split(':').map(Number);
            if (Number.isInteger(source_row) && Number.isInteger(source_column)) {
                commit_edit(source_row, source_column, live.value);
            }
        }
        const operation = on_save_request();
        if (
            !operation
            || operation.editSessionId !== edit_session_id
            || operation.saveRequestId.length === 0
        ) return false;
        const worksheet = worksheet_payload(operation);
        if (worksheet) {
            save_operation_ref.current = operation;
            saved_edits_ref.current = { ...worksheet.edits };
            save_in_flight_ref.current = true;
            set_save_in_flight(true);
            set_live_uncommitted(false);
            if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
            }
        }
        return true;
    }, [
        commit_edit,
        edit_session_id,
        on_save_request,
        read_live_edit,
        worksheet_payload,
    ]);

    /**
     * Grow a row to fit hard line breaks (Shift+Alt+Enter) in the text just committed to
     * it, and report whether it asked for a growth. Only ever grows: a row the user sized
     * larger by hand is left alone.
     *
     * Shared by *every* path that commits a cell value, which is the point of it being a
     * function rather than a branch inside `on_cell_edited`. There are two such paths and
     * only one of them is Glide's: App also folds an open multiline editor through
     * `commit_live_edit` when something is about to remount or re-project the grid — a
     * transform completing, a column-visibility change. That fold used to reach
     * `commit_edit` directly, so the text survived and the height did not, and the row
     * clipped its own content with nothing to explain why. It became reachable exactly
     * when this affordance stopped being gated on an unpermuted view, so the two belong to
     * the same change.
     *
     * Takes a *display* row deliberately, and resolves no source row even where the caller
     * has one to hand: `on_row_resize` speaks display intervals and the host owns the one
     * display→source mapper. The auto-grow comment in `on_cell_edited` has the full
     * version of that argument.
     */
    const auto_grow_row_for_text = useCallback((
        display_row: number,
        text: string,
    ): boolean => {
        // A fast path, and said so rather than dressed up as the gate: probed by deleting
        // it, and nothing failed, because `natural_row_height` floors at the default so an
        // ordinary one-line value measures *exactly* the default and the comparison below
        // refuses it anyway. The pair is what makes "a single-line commit resizes nothing"
        // true, and that claim is pinned by removing both. Kept because it is the cheaper
        // of the two and because it says what this affordance is for: hard line breaks, not
        // text length.
        if (!text.includes('\n')) return false;
        // Clamped because this comparison is the loop guard. `lines * line_height +
        // padding` is unbounded in the number of hard newlines a cell holds, and the
        // height that gets stored is clamped — so an unclamped `needed` would stay
        // strictly greater than the stored height forever and re-post a resize on every
        // single edit commit to that row, each one a no-op the host now answers with a
        // delivery. Clamping makes the two sides of the comparison the same quantity.
        const needed = clamp_row_height(natural_row_height(
            text,
            line_height_for_font(font_size_px),
            undefined,
            default_row_height,
        ));
        // `<=`, so a row already at the needed height posts nothing. That is not a
        // micro-optimization: `natural_row_height` floors at the default, so an ordinary
        // one-line value measures *exactly* the default and a `<` here would post a resize
        // for every edit commit — which is a durable write and a delivery each time. It is
        // also the second half of the guard against the unbounded case above, where the
        // clamped `needed` and the stored height meet at the ceiling.
        if (needed <= resolved_row_height(
            row_heights,
            row_height_overlay,
            display_row,
            default_row_height,
        )) return false;
        on_row_resize([{ start: display_row, end: display_row }], needed);
        return true;
    }, [
        default_row_height,
        font_size_px,
        on_row_resize,
        row_heights,
        row_height_overlay,
    ]);

    const commit_live_edit = useCallback((): void => {
        if (save_in_flight_ref.current) return;
        const live = read_live_edit();
        if (!live) return;
        // Source-keyed already: `live.key` comes from read_live_edit and
        // commit_edit's first parameter is a source row. No conversion here.
        const [source_row, source_column] = live.key.split(':').map(Number);
        if (!Number.isInteger(source_row) || !Number.isInteger(source_column)) return;
        commit_edit(source_row, source_column, live.value);
        // The display row for the same cell, read from the same selection `read_live_edit`
        // derived `live.key` from and in the same synchronous block — so the two name one
        // cell in the two spaces, with no mapping and no chance of drift.
        //
        // Whether the resize this posts is honoured depends on why the fold happened, and
        // that is the honest state of it rather than a gap. A fold for a column-visibility
        // change, or for a transform installing on *another* sheet, leaves this sheet's
        // mapping alone, so the host accepts it (`mapping_generation`, in
        // `viewer-controller`) and the height lands. A fold for a transform installing on
        // *this* sheet is refused, and must be: the display row here belongs to the
        // arrangement being left, and the reason resizes are never replayed is that
        // replaying one resizes whatever rows have moved into those positions. The text is
        // committed either way. No repaint, unlike `on_cell_edited`: every caller of this
        // is about to remount or re-project the grid, which repaints everything.
        const display_row = grid_selection_ref.current.current?.cell[1];
        if (display_row !== undefined) {
            auto_grow_row_for_text(display_row, live.value);
        }
        set_live_uncommitted(false);
    }, [
        auto_grow_row_for_text,
        commit_edit,
        read_live_edit,
        save_in_flight_ref,
    ]);

    const flush_live_edit = useCallback((): void => {
        commit_live_edit();
        const snapshot = store.snapshot();
        post_pending_edits(
            snapshot.size > 0 ? Object.fromEntries(snapshot) : null,
        );
    }, [commit_live_edit, post_pending_edits, store]);

    const has_uncommitted_changes = useCallback((): boolean => {
        if (store.size() > 0) return true;
        const live = read_live_edit();
        return !!live && live.value !== live.original;
    }, [read_live_edit, store]);

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
        if (close_barrier_ref.current || save_in_flight_ref.current) return;
        clear_dirty();
    }, [clear_dirty, save_in_flight_ref]);
    const guarded_discard_conflicted = useCallback(() => {
        if (close_barrier_ref.current || save_in_flight_ref.current) return;
        discard_conflicted();
    }, [discard_conflicted, save_in_flight_ref]);
    const guarded_discard_keys = useCallback((keys: readonly string[]) => {
        if (close_barrier_ref.current || save_in_flight_ref.current) return;
        if (keys.length === 0) return;
        // Host-named keys are already source-keyed, so they go straight into the
        // source-keyed store with no conversion — the payoff for having moved
        // durable identity to the source row first.
        clear_dirty_keys(new Set(keys));
    }, [clear_dirty_keys, save_in_flight_ref]);

    // Expose the imperative actions to App through the ref it provides.
    useEffect(() => {
        if (!editing_ref) return;
        editing_ref.current = {
            request_save,
            clear_dirty: guarded_clear_dirty,
            discard_conflicted: guarded_discard_conflicted,
            discard_keys: guarded_discard_keys,
            stop_edit_admission() {
                close_barrier_ref.current = true;
                set_close_barrier_active(true);
            },
            commit_live_edit,
            flush_live_edit,
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
        guarded_discard_keys,
        commit_live_edit,
        flush_live_edit,
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

    // Truncated-cell hover tooltip. Shown after a short dwell only when the
    // displayed value does not fit the painted cell (horizontal ellipsis or
    // vertical clip of wrapped / multiline text). Cleared on leave, scroll,
    // and unmount so a stale bubble never lingers over a moved cell.
    type CellTooltipState = {
        text: string;
        bounds: { x: number; y: number; width: number; height: number };
        left: number;
        top: number;
    };
    const [cell_tooltip, set_cell_tooltip] = useState<CellTooltipState | null>(null);
    const cell_tooltip_timer_ref = useRef<number | null>(null);
    const cell_tooltip_el_ref = useRef<HTMLDivElement | null>(null);
    const cell_tooltip_key_ref = useRef<string | null>(null);

    const clear_cell_tooltip_timer = useCallback(() => {
        if (cell_tooltip_timer_ref.current !== null) {
            window.clearTimeout(cell_tooltip_timer_ref.current);
            cell_tooltip_timer_ref.current = null;
        }
    }, []);

    const hide_cell_tooltip = useCallback(() => {
        clear_cell_tooltip_timer();
        cell_tooltip_key_ref.current = null;
        set_cell_tooltip(null);
    }, [clear_cell_tooltip_timer]);
    hide_cell_tooltip_ref.current = hide_cell_tooltip;

    useEffect(() => () => {
        clear_cell_tooltip_timer();
    }, [clear_cell_tooltip_timer]);

    const ensure_measure_ctx = useCallback((): CanvasRenderingContext2D | null => {
        if (!measure_ctx_ref.current) {
            measure_ctx_ref.current = document
                .createElement('canvas')
                .getContext('2d');
        }
        return measure_ctx_ref.current;
    }, []);

    /** Displayed text for the tooltip / overflow check at a display cell. */
    const displayed_cell_text = useCallback(
        (display_column: number, row: number): string => {
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) return '';
            // Source-keyed dirty lookup. When the source row is unresolved there
            // can be no edit to show, so fall through to the persisted-cell path
            // below (which reads the same non-resident row and yields '').
            const source_row = get_source_row(row);
            const dirty = source_row === undefined
                ? undefined
                : store.get(`${source_row}:${source_column}`);
            if (dirty) return dirty.value;

            const merge = merge_index.entry_at(row, source_column);
            // Vertical / 2D merges paint via the overlay from the anchor cell.
            if (merge && !merge.horizontalOnly) {
                const anchor_row = get_row(merge.startRow);
                const anchor = anchor_row?.[merge.startCol];
                if (!anchor) return '';
                return show_formatting ? anchor.formatted : (anchor.raw ?? '');
            }
            // Horizontal merges echo the anchor on every spanned cell.
            const content_col = merge?.horizontalOnly ? merge.startCol : source_column;
            const cells = get_row(row);
            const cell = cells?.[content_col];
            if (!cell) return '';
            return show_formatting ? cell.formatted : (cell.raw ?? '');
        },
        [
            get_row,
            get_source_row,
            merge_index,
            show_formatting,
            source_column_for_display,
            store,
        ],
    );

    const measure_line_width = useCallback(
        (line: string, bold: boolean, italic: boolean): number => {
            const ctx = ensure_measure_ctx();
            if (!ctx) return line.length * 7;
            ctx.font = canvas_font(
                show_formatting && bold,
                show_formatting && italic,
                font_family,
                font_size_px,
            );
            return ctx.measureText(line).width;
        },
        [ensure_measure_ctx, font_family, font_size_px, show_formatting],
    );

    const font_flags_for_cell = useCallback(
        (display_column: number, row: number): { bold: boolean; italic: boolean } => {
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) return { bold: false, italic: false };
            const merge = merge_index.entry_at(row, source_column);
            // Content (and its bold/italic) always lives on the merge anchor.
            const content_row = merge && !merge.horizontalOnly ? merge.startRow : row;
            const content_col = merge ? merge.startCol : source_column;
            const cell = get_row(content_row)?.[content_col];
            return {
                bold: !!cell?.bold,
                italic: !!cell?.italic,
            };
        },
        [get_row, merge_index, source_column_for_display],
    );

    /** Expand hover bounds to the full painted merge block when needed. */
    const tooltip_bounds_for_cell = useCallback(
        (
            display_column: number,
            row: number,
            cell_bounds: { x: number; y: number; width: number; height: number },
        ): { x: number; y: number; width: number; height: number } => {
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) return cell_bounds;
            const merge = merge_index.entry_at(row, source_column);
            // Horizontal spans already report the full block via Glide's bounds.
            if (!merge || merge.horizontalOnly) return cell_bounds;
            const start_display = display_column_for_source(merge.startCol);
            const end_display = display_column_for_source(merge.endCol);
            if (start_display === undefined || end_display === undefined) return cell_bounds;
            const top_left = grid_ref.current?.getBounds(start_display, merge.startRow);
            const bottom_right = grid_ref.current?.getBounds(end_display, merge.endRow);
            if (!top_left || !bottom_right) return cell_bounds;
            return {
                x: top_left.x,
                y: top_left.y,
                width: bottom_right.x + bottom_right.width - top_left.x,
                height: bottom_right.y + bottom_right.height - top_left.y,
            };
        },
        [display_column_for_source, merge_index, source_column_for_display],
    );

    const schedule_cell_tooltip = useCallback(
        (
            display_column: number,
            row: number,
            cell_bounds: { x: number; y: number; width: number; height: number },
        ) => {
            // Deliberately a **display**-space key, unlike the dirty-map keys: this
            // is a hover-dedup cache for the cell the pointer is physically over,
            // not an edit identity. Keying it by source row would make two display
            // rows that share a source row dedup against each other and suppress
            // the second one's tooltip.
            const key = `${row}:${display_column}`;
            // Same cell still hovered — keep an already-visible tooltip, or let
            // the pending timer fire. Avoid restarting the dwell on every move.
            if (cell_tooltip_key_ref.current === key) return;

            clear_cell_tooltip_timer();
            cell_tooltip_key_ref.current = key;
            set_cell_tooltip(null);

            const text = displayed_cell_text(display_column, row);
            if (!text) return;

            const bounds = tooltip_bounds_for_cell(display_column, row, cell_bounds);
            const flags = font_flags_for_cell(display_column, row);
            const wrapping = text.includes('\n');
            const overflows = text_overflows_cell(
                text,
                bounds.width,
                (line) => measure_line_width(line, flags.bold, flags.italic),
                {
                    cell_height: bounds.height,
                    line_height: line_height_for_font(font_size_px),
                    wrapping,
                },
            );
            if (!overflows) return;

            const clamped = clamp_tooltip_text(text);
            cell_tooltip_timer_ref.current = window.setTimeout(() => {
                cell_tooltip_timer_ref.current = null;
                // Drop if the pointer left this cell during the dwell.
                if (cell_tooltip_key_ref.current !== key) return;
                // Initial placement uses an estimated size; layout effect below
                // re-centers once the real tooltip box is measured.
                const estimated = {
                    width: Math.min(360, Math.max(80, clamped.length * 7)),
                    height: 28 + (clamped.match(/\n/g)?.length ?? 0) * 16,
                };
                const pos = cell_tooltip_position(bounds, estimated);
                set_cell_tooltip({
                    text: clamped,
                    bounds,
                    left: pos.left,
                    top: pos.top,
                });
            }, CELL_TOOLTIP_SHOW_DELAY_MS);
        },
        [
            clear_cell_tooltip_timer,
            displayed_cell_text,
            font_flags_for_cell,
            font_size_px,
            measure_line_width,
            tooltip_bounds_for_cell,
        ],
    );

    // Re-measure the mounted tooltip and re-clamp into the viewport so long
    // multi-line content doesn't sit off-screen after the estimate.
    useLayoutEffect(() => {
        if (!cell_tooltip) return;
        const el = cell_tooltip_el_ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pos = cell_tooltip_position(cell_tooltip.bounds, {
            width: rect.width,
            height: rect.height,
        });
        if (
            Math.abs(pos.left - cell_tooltip.left) > 0.5
            || Math.abs(pos.top - cell_tooltip.top) > 0.5
        ) {
            set_cell_tooltip({
                ...cell_tooltip,
                left: pos.left,
                top: pos.top,
            });
        }
    }, [cell_tooltip]);

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
            ctx.font = canvas_font(
                cell.bold,
                cell.italic,
                font_family,
                font_size_px,
            );
            return ctx.measureText(cell.text).width;
        };
        return fit_column_widths(cells, visible_source_columns, measure);
    }, [
        has_visible_columns,
        show_formatting,
        font_family,
        font_size_px,
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
            // Resolve durable edit identity at overlay-open time, not at commit:
            // the one thing we must never do is accept typed text and then drop it
            // for want of a source row. No key ⇒ no dirty lookup, no conflict tint,
            // and no overlay.
            //
            // Deliberately does NOT call ensure_rows to fetch the missing page.
            // This is Glide's per-cell paint callback (every visible cell, every
            // frame) and ensure_rows *overwrites* the loader's `viewport`, so one
            // cell's coordinates would clobber the real visible range. It is also
            // unnecessary: `on_visible_region_changed` already requests exactly the
            // rows Glide paints, so the page is in flight, and the `version` dep
            // below repaints the cell — making it editable — once it lands.
            //
            // That does mean a real, if small, behavior change: a cell on a
            // not-yet-landed page is briefly non-editable where today it is
            // immediately editable. It self-heals within one host round-trip, and
            // the alternative (editable now, silently discard the edit later) is
            // not acceptable.
            const source_row = get_source_row(row);
            const key = source_row === undefined
                ? undefined
                : `${source_row}:${source_column}`;
            const dirty = key === undefined ? undefined : store.get(key);
            const merge = merge_index.entry_at(row, source_column);
            // Reuse the row's own resolution when there is no merge, which is the
            // overwhelmingly common case: `entry_at` returns null on a sheet with no
            // merges, and a second get_source_row for the identical row is a second
            // `locate()` allocation per cell per frame.
            const highlight_source_row = merge === null
                ? source_row
                : get_source_row(merge.startRow);
            const highlight_source_column = merge?.startCol ?? source_column;
            const highlight_bg = highlight_source_row === undefined
                ? undefined
                : get_highlight_background(
                    highlight_source_row,
                    highlight_source_column,
                );
            // Tint + dirty text whenever an edit exists; open the overlay only in
            // edit mode and only where source identity resolved. A resident blank
            // cell stays editable so blanks can still be typed.
            // dirty read through the stable `store` handle and conflict through
            // conflicted_keys_ref — never through the subscribed dirty_cells — so
            // this closure's identity doesn't churn per edit; the targeted repaint
            // effect damages the cells whose tint actually changed.
            const editable = editable_cells && source_row !== undefined;
            let overlay: CellEditOverlay | undefined;
            if (editable_cells || dirty || highlight_bg) {
                overlay = {
                    editable,
                    // `refused` is narrower than `!editable` on purpose: it means
                    // "editing is on here and we are refusing this cell", which is
                    // the only situation where Glide's paste path needs closing. A
                    // read-only sheet is not refusing anything — it never offered —
                    // and it does reach this branch, via highlight_bg, which is
                    // plain view state independent of edit mode.
                    refused: editable_cells && source_row === undefined,
                    dirty_value: dirty?.value,
                    bg: dirty
                        ? key !== undefined && conflicted_keys_ref.current.has(key)
                            ? conflict_bg
                            : dirty_bg
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
                font_size_px,
            );
        },
        // version: bumps when a page lands so the closure (and the redraw effect) refresh.
        [
            get_row,
            show_formatting,
            version,
            merge_index,
            editable_cells,
            font_size_px,
            source_column_for_display,
            get_source_row,
            get_highlight_background,
            store,
            // A theme switch re-derives the tints, so the callback must close
            // over the new ones (the full-region repaint effect below then
            // damages the cells already painted with the old ones).
            dirty_bg,
            conflict_bg,
        ],
    );

    // Glide opens its own overlay editor; it reports the committed value here
    // with the cell location, which we fold into the dirty map.
    const on_cell_edited = useCallback(
        (cell: Item, new_value: EditableGridCell) => {
            if (close_barrier_ref.current || save_in_flight_ref.current) return;
            const [display_column, row] = cell;
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) return;
            // Resolve source identity here as well as at overlay-open time.
            // get_cell_content's `editable` gate covers the overlay and Glide's
            // activation/delete paths, but Glide's paste path never consults
            // `allowOverlay` (see the `readonly` flag in cell-renderer.ts), so this
            // is the second of the two guards keeping an unresolvable row from
            // landing an edit under the wrong key.
            //
            // Live residency first, then the identity this overlay opened with:
            // Glide passes `overlay.cell` (the coordinates the editor opened on) to
            // onFinishEditing, so the captured entry names exactly this commit's row
            // and the guard keeps refusing only the genuinely unresolvable case.
            const source_row = commit_source_row(row);
            if (source_row === undefined) return;
            const text =
                new_value.kind === GridCellKind.Text ? new_value.data ?? '' : '';
            commit_edit(source_row, source_column, text);
            // Auto-grow the row to fit hard line breaks (Shift+Alt+Enter),
            // mirroring the old renderer. Only ever grows a row, never shrinks a
            // user-sized one; repaints the whole row + overlay at the new height.
            // The measurement and the resize live in `auto_grow_row_for_text` because
            // this is not the only path that commits a value — see there.
            //
            // No longer gated on a `transformed` prop — which no longer exists, having had
            // no readers left once this was its last one. It used to be, because a height was
            // persisted under the display row it was measured at, which under a
            // permutation named some other source row — durable corruption, so the
            // whole affordance was suppressed rather than risked. Now the height goes
            // up as a display interval and the host maps it through the permutation it
            // installed, so a permuted view is no different from an unpermuted one; and
            // `row_heights` is itself display-keyed, so the comparison below is a
            // like-for-like read at this row. This site *could* resolve `source_row` (it
            // did so just above, to key the edit) and deliberately does not: one
            // display→source mapper, host-side, is the invariant the design rests on.
            if (auto_grow_row_for_text(row, text)) {
                const cells: { cell: Item }[] = [];
                for (let display_column = 0; display_column < display_column_count; display_column++) {
                    cells.push({ cell: [display_column, row] });
                }
                grid_ref.current?.updateCells(cells);
                overlay_ref.current?.repaint();
                return;
            }
            grid_ref.current?.updateCells([{ cell: [display_column, row] }]);
        },
        [
            auto_grow_row_for_text,
            commit_edit,
            display_column_count,
            source_column_for_display,
            commit_source_row,
            save_in_flight_ref,
        ],
    );

    // Tracking wrapper around the custom CSV editor: it makes the open overlay's
    // dirtiness observable (live_uncommitted) so App doesn't have to poll the DOM.
    // Refreshes on open and on every keystroke, clears on close. Memoized so its
    // identity is stable — Glide would otherwise remount (and unfocus) the editor
    // on each parent render.
    //
    // Its mount/unmount is also the "overlay opened / closed" hook, and the only
    // one available: Glide owns the overlay's lifetime and exposes no open
    // callback, and onFinishedEditing fires on close but not on open. So the same
    // effect that arms live_uncommitted captures this overlay's source-row identity
    // and pins its page, and the cleanup releases both — which is what makes the
    // pin release airtight for the ordinary close (Enter/Esc/click-away), a
    // selection move, and an unmount.
    const tracking_editor = useMemo(() => {
        function TrackingCsvCellEditor(props: CsvCellEditorProps): React.JSX.Element {
            useEffect(() => {
                capture_open_overlay_row();
                refresh_live_uncommitted();
                return () => {
                    // Ordering matters: on_cell_edited already ran by the time Glide
                    // tears the editor down (onFinishEditing commits, then clears the
                    // overlay), so releasing here cannot strip the capture out from
                    // under the commit that needs it.
                    const target = pending_editor_navigation_ref.current;
                    pending_editor_navigation_ref.current = null;
                    release_open_overlay_row();
                    set_live_uncommitted(false);
                    if (target) {
                        select_active_display_cell_ref.current(target);
                        focus_grid_ref.current();
                    }
                };
            }, []);
            const handle_change = (next: GridCell) => {
                if (save_in_flight_ref.current || close_barrier_ref.current) return;
                props.onChange(next);
                // Keep the live overlay in the renderer snapshot without turning
                // every keystroke into a host state write. A close/reload flush reads
                // this snapshot synchronously; ordinary edits publish on commit.
                refresh_live_uncommitted();
            };
            const handle_commit_navigation: NonNullable<
                CsvCellEditorProps['onCommitNavigation']
            > = (navigation) => {
                pending_editor_navigation_ref.current = null;
                const captured = open_overlay_row_ref.current;
                if (!captured) return;
                const target = move_sequential_cell(
                    captured.display_cell,
                    navigation,
                    row_count_ref.current,
                    display_column_count_ref.current,
                );
                pending_editor_navigation_ref.current = [target[0], target[1]];
            };
            const handle_finished: CsvCellEditorProps['onFinishedEditing'] = (
                next,
                movement,
            ) => {
                if (next === undefined) pending_editor_navigation_ref.current = null;
                props.onFinishedEditing(next, movement);
                if (next !== undefined) return;
                // Escape retracts the speculative overlay projection after Glide
                // has closed it. Ordinary commits are published by the dirty-store
                // effect; a document unload does not unmount React effects and
                // therefore leaves the latest per-keystroke projection intact.
                queueMicrotask(() => {
                    const edits = Object.fromEntries(store.snapshot());
                    post_pending_edits(Object.keys(edits).length > 0 ? edits : null);
                });
            };
            return (
                <CsvCellEditor
                    {...props}
                    onChange={handle_change}
                    onFinishedEditing={handle_finished}
                    onCommitNavigation={handle_commit_navigation}
                />
            );
        }
        return TrackingCsvCellEditor;
    }, [
        capture_open_overlay_row,
        post_pending_edits,
        refresh_live_uncommitted,
        release_open_overlay_row,
        save_in_flight_ref,
        store,
    ]);

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
        (row: number) => {
            if (
                row_resize_preview
                && (
                    row_resize_preview.row === row
                    || row_resize_preview.preview_rows?.hasIndex(row)
                )
            ) return row_resize_preview.height;
            return resolved_row_height(
                row_heights,
                row_height_overlay,
                row,
                default_row_height,
            );
        },
        [default_row_height, row_heights, row_height_overlay, row_resize_preview],
    );

    // Repaint merge geometry after live-preview and committed-height renders.
    // Repainting inline with the pointer handler is too early: Glide has not yet
    // applied the new rowHeight callback, leaving vertical/2D bounds one tick old.
    useEffect(() => {
        overlay_ref.current?.repaint();
    }, [row_heights, row_height_overlay, row_resize_preview]);

    // Arm/clear the row-resize strip as the pointer nears a row border. Glide's
    // hover args give the cell's client `bounds` + in-cell `localEventY`.
    // Also drives the truncated-cell tooltip: dwell on an overflowing cell
    // surfaces the full displayed value without changing selection or edit mode.
    const on_item_hovered = useCallback(
        (args: GridMouseEventArgs) => {
            row_markers.observe_hover(args);
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
                        write_grid_selection({
                            columns,
                            rows: CompactSelection.empty(),
                        });
                    }
                    // Sweeping columns; don't arm the row-resize strip mid-drag.
                    row_resize_ref.current?.set_target(null);
                    hide_cell_tooltip();
                    return;
                }
            }
            if (row_markers.handle_hover_drag(args)) {
                // Sweeping rows; don't arm the row-resize strip mid-drag.
                row_resize_ref.current?.set_target(null);
                hide_cell_tooltip();
                return;
            }
            if (args.kind !== 'cell' || args.location[0] < 0 || args.location[1] < 0) {
                hide_cell_tooltip();
            } else if ((args.buttons & 1) !== 0) {
                // Primary button down (drag-select / resize) — no tooltip.
                hide_cell_tooltip();
            } else {
                schedule_cell_tooltip(
                    args.location[0],
                    args.location[1],
                    args.bounds,
                );
            }
            // No `transformed` bail here any more; the prop it read is gone with it.
            // Arming the strip was suppressed
            // under a permutation only because the resize it leads to used to persist a
            // display-keyed height; the resize now names display intervals the host
            // maps, so there is nothing left for a permutation to mis-key.
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
                          height: resolved_row_height(
                              row_heights,
                              row_height_overlay,
                              hit.row,
                              default_row_height,
                          ),
                      }
                    : null,
            );
        },
        [
            default_row_height,
            display_column_count,
            hide_cell_tooltip,
            row_heights,
            row_height_overlay,
            row_markers,
            schedule_cell_tooltip,
            write_grid_selection,
        ],
    );

    // Snapshot the compact row selection once. Live moves retain that compact
    // representation so even select-all previews stay bounded to the viewport;
    // the final heights are expanded and persisted once on mouseup.
    const handle_row_resize_start = useCallback((row: number, height: number) => {
        const selected_rows = grid_selection_ref.current.rows;
        const commit_rows = selected_rows.hasIndex(row) ? selected_rows : null;
        const preview: RowResizePreview = {
            row,
            commit_rows,
            // Previewing rows above the dragged boundary would move that
            // boundary once per preceding row and make it outrun the pointer.
            // Glide uses this same first-selected-item rule for columns.
            preview_rows: commit_rows?.first() === row ? commit_rows : null,
            start_height: height,
            height,
        };
        row_resize_preview_ref.current = preview;
    }, []);

    const handle_row_resize_drag = useCallback(
        (row: number, height: number) => {
            const current = row_resize_preview_ref.current;
            if (!current || current.row !== row || current.height === height) return;
            const preview = { ...current, height };
            row_resize_preview_ref.current = preview;
            set_row_resize_preview(preview);
            const visible = visible_ref.current;
            const first_column = Math.max(0, visible.x);
            const last_column = Math.min(
                display_column_count,
                visible.x + visible.width,
            );
            const cells: { cell: Item }[] = [];
            const first_row = Math.max(0, visible.y);
            const last_row = Math.min(row_count, visible.y + visible.height);
            for (let target_row = first_row; target_row < last_row; target_row++) {
                if (
                    target_row !== preview.row
                    && !preview.preview_rows?.hasIndex(target_row)
                ) continue;
                for (
                    let display_column = first_column;
                    display_column < last_column;
                    display_column++
                ) {
                    cells.push({ cell: [display_column, target_row] });
                }
            }
            if (cells.length > 0) grid_ref.current?.updateCells(cells);
        },
        [display_column_count, row_count],
    );

    const handle_row_resize_end = useCallback((row: number, height: number) => {
        const preview = row_resize_preview_ref.current;
        row_resize_preview_ref.current = null;
        set_row_resize_preview(null);
        if (!preview || preview.row !== row || height === preview.start_height) return;
        // Handed up as intervals, never as the expanded row list this used to pass.
        // `commit_rows` is the user's whole row selection and can be select-all, so the
        // expansion produced one number per row of the sheet purely to say "all of
        // them" — and the message would then have carried a copy of it across the
        // bridge. Coalescing is `selected_display_row_intervals`', reused rather than
        // rewritten; it is also the clamp against `row_count`.
        //
        // It still walks the selection once (`CompactSelection.toArray` — the class
        // keeps its ranges in a *private* field, so nothing typed can read them), which
        // is the cost the old code paid too. The saving that matters is downstream: what
        // crosses to the host, and what the host counts against
        // `MAX_PERSISTED_ROW_HEIGHTS` before allocating anything.
        const selected = preview.commit_rows
            ? selected_display_row_intervals(
                { columns: CompactSelection.empty(), rows: preview.commit_rows },
                row_count,
            )
            : null;
        on_row_resize(selected ?? [{ start: row, end: row }], height);
    }, [on_row_resize, row_count]);

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

    const select_rect = useCallback((anchor: Item, range: Rectangle) => {
        write_grid_selection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: { cell: anchor, range, rangeStack: [] },
        });
    }, [write_grid_selection]);

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

    const on_grid_selection_change = useCallback(
        (sel: GridSelection) => {
            if (row_markers.intercept_selection_change(
                sel,
                display_column_count,
                select_all,
            )) return;
            if (!sel.current) {
                header_drag_ref.current = sel.columns.length > 0
                    ? header_drag_state_for_selection(
                        grid_selection_ref.current.columns,
                        sel.columns,
                    )
                    : null;
                write_grid_selection(sel);
                return;
            }
            header_drag_ref.current = null;
            const { cell, range } = expand_glide_selection(
                sel.current.cell,
                sel.current.range,
                merges,
            );
            write_grid_selection({
                columns: sel.columns,
                rows: sel.rows,
                current: { cell, range, rangeStack: sel.current.rangeStack },
            });
        },
        [display_column_count, merges, row_markers, select_all, write_grid_selection],
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
        const dirty = store.snapshot();
        const live = read_live_edit();
        const get_displayed_row = (
            row_index: number,
        ): (RenderedCell | null)[] | undefined => {
            // `source_cells` is the row's *cells* (formerly misnamed source_row),
            // renamed so the real source row below can carry that name.
            const source_cells = get_row_ref.current(row_index);
            if (source_cells === undefined) return undefined;
            // Edit keys are source-keyed, so the dirty/live lookups need this row's
            // canonical identity. Bailing when it is unresolved matches the residency
            // rule above: a row must be resident before edits are overlaid, and a
            // resolved source row is exactly what residency means here.
            const source_row = get_source_row(row_index);
            if (source_row === undefined) return undefined;
            let displayed_row: (RenderedCell | null)[] | undefined;
            for (const source_column of selection.source_columns) {
                const key = `${source_row}:${source_column}`;
                const displayed_value = live?.key === key
                    ? live.value
                    : dirty.get(key)?.value;
                if (displayed_value === undefined) continue;
                displayed_row ??= [...source_cells];
                const source_cell = source_cells[source_column];
                displayed_row[source_column] = {
                    raw: displayed_value,
                    formatted: displayed_value,
                    bold: source_cell?.bold ?? false,
                    italic: source_cell?.italic ?? false,
                    rawType: 'string',
                };
            }
            return displayed_row ?? source_cells;
        };
        const result = format_selection_tsv(
            selection,
            get_displayed_row,
            merge_index,
            show_formatting,
        );
        const warning = copy_truncation_message(result);
        if (warning) {
            host_bridge.postMessage({ type: 'showWarning', message: warning });
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
        get_source_row,
        merge_index,
        read_live_edit,
        sheet_meta.columnNames,
        show_formatting,
        safe_write_to_clipboard,
        store,
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

    // What the menu-driven Copy command acts on: the dragged cell rectangle
    // when there is one, else a row-marker selection. Mirrors what Glide's own
    // Ctrl+C would have copied, for hosts whose native menu swallows that key.
    const copy_selection = useCallback(() => {
        const selection = grid_selection_ref.current;
        const range = selection.current?.range;
        if (range) {
            copy_rect(range);
            return;
        }
        const rows = selected_display_row_intervals(selection, row_count);
        if (rows) copy_display_rows(rows);
    }, [copy_display_rows, copy_rect, row_count]);

    // Whole visible sheet with a header row (delegates to copy_rect, so the same
    // clipboard-failure and truncation handling applies). Because this copies
    // rows the user may never have scrolled into view — "Copy sheet" can target
    // a sheet that was just switched to, whose pages are still in flight — load
    // the full range (bounded by the copy cap) before serializing, so the copy
    // doesn't come back blank with a "scroll to load" warning it can't act on.
    const copy_sheet = useCallback(async () => {
        if (row_count === 0 || display_column_count === 0) return;
        const loaded = await ensure_rows_loaded(0, Math.min(row_count, DEFAULT_MAX_ROWS) - 1);
        // A sheet switch or reload cleared the cache mid-load: abandon the copy
        // rather than overwrite the clipboard with a now-empty grid.
        if (!loaded) return;
        copy_rect({
            x: 0,
            y: 0,
            width: display_column_count,
            height: row_count,
        }, true);
    }, [copy_rect, display_column_count, ensure_rows_loaded, row_count]);

    // Publish sheet-tab actions to App, mirroring the grid_focus_ref bridge. The
    // sheet_index lets App reject a stale handle during a keyed remount.
    useEffect(() => {
        if (!grid_actions_ref) return;
        const handle: GridActionsHandle = {
            sheet_index,
            select_all,
            copy_sheet,
            copy_selection,
        };
        grid_actions_ref.current = handle;
        return () => {
            if (grid_actions_ref.current === handle) grid_actions_ref.current = null;
        };
    }, [copy_selection, copy_sheet, grid_actions_ref, select_all, sheet_index]);

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
            // Source-keyed, so resolve the row's identity. A dirty cell was resident
            // when it was committed, but its page may have been evicted since — with
            // no source row there is no key to remove, and guessing one would delete
            // some other row's edit.
            const source_row = get_source_row(row);
            if (source_row === undefined) return;
            clear_dirty_keys(new Set([`${source_row}:${source_column}`]));
            grid_ref.current?.updateCells([{ cell: [display_column, row] }]);
        },
        [clear_dirty_keys, get_source_row, save_in_flight_ref],
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
        write_grid_selection({
            columns: CompactSelection.fromSingleSelection(display_column),
            rows: CompactSelection.empty(),
        });
    }, [source_column_for_display, write_grid_selection]);

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
                hide_cell_tooltip();
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
        hide_cell_tooltip();
        set_context_menu({
            kind: 'header',
            x,
            y,
            display_col: display_column,
            source_col: source_column,
        });
    }, [hide_cell_tooltip, select_header_column, source_column_for_display]);

    // Glide gives no clientX/clientY — derive them from the cell bounds plus the
    // in-cell offset. Right-clicking outside the current selection collapses it to
    // the clicked cell (merge-snapped), matching native grid behavior.
    const on_cell_context_menu = useCallback(
        (cell: Item, event: CellClickedEventArgs) => {
            event.preventDefault();
            const [col, row] = cell;
            if (col < 0) {
                row_markers.on_context_menu(row, event);
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
            hide_cell_tooltip();
            set_context_menu({
                kind: 'cell',
                x: event.bounds.x + event.localEventX,
                y: event.bounds.y + event.localEventY,
                row: anchor_row,
                display_col: anchor_col,
                source_col: source_column,
            });
        },
        [hide_cell_tooltip, merges, row_markers, select_rect, source_column_for_display],
    );

    const dismiss_context_menu = useCallback(() => set_context_menu(null), []);

    // Controlled keyboard nav. Tab/Shift+Tab use row-major wrapping; merged-sheet
    // arrows and view-mode hjkl retain the existing merge-aware movement. Other
    // range extension and shortcut behavior stays native to Glide.
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
            const target = decision.kind === 'sequential'
                ? move_sequential_cell(
                    cur,
                    decision.navigation,
                    row_count,
                    display_column_count,
                    (row, col) => merge_index.is_covered(row, col),
                )
                : (() => {
                    const next = move_active_cell(
                        cur_row,
                        cur_col,
                        decision.direction,
                        row_count,
                        display_column_count,
                        merges,
                    );
                    return [next.col, next.row] as Item;
                })();
            args.cancel();
            args.preventDefault();
            select_active_display_cell([target[0], target[1]]);
        },
        [
            apply_column_sort,
            clear_filter_on_column,
            copy_rect,
            copy_source_selection,
            display_column_count,
            display_column_for_source,
            editable_cells,
            merge_index,
            merges,
            on_open_filter,
            on_transform_change,
            row_count,
            select_active_display_cell,
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
            // Scroll moves cells under the cursor; drop any open tooltip so it
            // can't float over the wrong content mid-scroll.
            hide_cell_tooltip();
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
                host_bridge.postMessage({ type: 'visibleRowChanged', row: start });
            }
        },
        [
            ensure_rows,
            hide_cell_tooltip,
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
    // bump), the formatting toggle (raw ↔ formatted), the edit-mode toggle
    // (flips each cell's allowOverlay), and a font-size or edit-tint change
    // (each cell carries both in its theme override). A parent re-render alone
    // does not reliably invalidate Glide's per-cell cache, so damage explicitly.
    // (Sheet/merge changes remount via the grid key.)
    //
    // The merge overlay draws its own text, reading the size off the theme at
    // paint time, and is only otherwise repainted by content/highlight changes —
    // so repaint it here too, or merged cells keep the previous size.
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
        overlay_ref.current?.repaint();
    }, [
        version,
        show_formatting,
        editable_cells,
        display_column_count,
        font_size_px,
        // A theme switch re-derives the tints; without these, already-painted
        // dirty/conflicted cells keep the previous theme's color until they
        // happen to be damaged for some other reason.
        dirty_bg,
        conflict_bg,
    ]);

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
        // Dirty keys are source-keyed, so a changed key's row is a source row and
        // cannot be used as a display coordinate. Reuse the shared visible-row scan
        // the highlight effect already uses: it maps source → display over the
        // visible range and handles one source row appearing at several display
        // rows, which a reverse display lookup could not.
        const cells = visible_source_key_damage(
            changed,
            visible_ref.current,
            display_column_for_source,
            get_source_row,
        ).map(({ cell }) => ({ cell: cell as Item }));
        if (cells.length > 0) grid.updateCells(cells);
    }, [dirty_cells, conflicted_keys, display_column_for_source, get_source_row]);

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
        const cells = visible_source_key_damage(
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
        // Columns the selection spans; hide targets all of them (falls back to
        // the clicked column when the selection maps to nothing usable).
        const selected_column_sources = selected_display_columns(
            grid_selection,
            display_column_count,
        )
            .map(source_column_for_display)
            .filter((column): column is number => column !== undefined);
        const hide_column_targets = selected_column_sources.length > 0
            ? selected_column_sources
            : [source_col];
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
        // Source-keyed dirty probe. An unresolved source row reports `false` rather
        // than guessing: it is also the case where discard_edit would have no key to
        // remove, so hiding "Discard edit" is the consistent answer.
        const menu_source_row = get_source_row(row);
        cell_menu_items = cell_context_menu_items({
            dirty: menu_source_row !== undefined
                && dirty_cells.has(`${menu_source_row}:${source_col}`),
            is_multi_cell: !!range && range.width * range.height > 1,
            preview_mode,
            // Hiding rows is offered in edit mode: it is a transform like any
            // other, and the host admits it from the panel holding the session.
            // Preview keeps its refusal — natural source order is a trust
            // boundary there.
            can_hide_rows: !!selected_rows
                && transform_sections
                && !transform_pending
                && !preview_mode,
            selected_row_count,
            selected_column_count: hide_column_targets.length,
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
            on_hide_columns: () => {
                if (hide_column_targets.length === 1) {
                    hide_source_column(hide_column_targets[0]);
                } else {
                    hide_source_columns_multi(hide_column_targets);
                }
            },
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
        <div
            ref={grid_root_ref}
            className="grid-shell-root"
            onPointerDownCapture={row_markers.on_pointer_down_capture}
        >
            <DataEditor
                ref={grid_ref}
                className="glide-grid"
                width="100%"
                height="100%"
                rows={row_count}
                columns={columns}
                getCellContent={get_cell_content}
                rowHeight={get_row_height}
                rowMarkers="clickable-number"
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
                onCellClicked={row_markers.on_cell_clicked}
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
            {/*
              * Mounted unconditionally. It used to be withheld under a permutation,
              * because the height a drag committed was persisted at the display row it
              * was dragged on and that named the wrong source row — so the affordance
              * was removed rather than allowed to corrupt durable state. The drag now
              * reports display intervals and the host maps them through the very
              * permutation the user was looking at, which makes a permuted view an
              * ordinary case.
              */}
            <RowResizeOverlay
                ref={row_resize_ref}
                on_resize_start={handle_row_resize_start}
                on_resize={handle_row_resize_drag}
                on_resize_end={handle_row_resize_end}
            />
            {cell_tooltip && (
                <div
                    ref={cell_tooltip_el_ref}
                    className="cell-overflow-tooltip"
                    role="tooltip"
                    style={{
                        left: cell_tooltip.left,
                        top: cell_tooltip.top,
                    }}
                >
                    {cell_tooltip.text}
                </div>
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
                            // Offered in edit mode, refused in preview; see the
                            // cell menu's can_hide_rows above.
                            can_hide_rows: transform_sections
                                && !transform_pending
                                && !preview_mode,
                            // Left as it was, `!edit_mode` included. The sort/filter
                            // restriction is about row order — promoting a row hides
                            // the rows above it, which only means anything in
                            // natural order — and README documents the action as
                            // available only when nothing is reordering the view.
                            // With transform_state no longer emptied in edit mode
                            // that restriction now *also* sees an edit-mode sort, so
                            // the two terms agree rather than one masking the other.
                            can_promote_row_to_header: can_promote_row_to_header
                                && transform_sections
                                && !transform_pending
                                && !edit_mode
                                && !preview_mode
                                && transform_state.sort.length === 0
                                && !transform_state.filters.some((filter) => filter.enabled),
                            on_hide_rows: () => on_hide_rows(context_menu.display_rows),
                            on_promote_row_to_header: () =>
                                on_promote_row_to_header(context_menu.row),
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
