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
    transform_has_entries,
    transform_is_active,
    transform_schema_for_sheet,
    type PerFileState,
    type HostMessage,
    type SheetTransformState,
    type FilterEntry,
    type SheetColumnVisibilityState,
    type TransformIntent,
} from '../types';
import type { WorkbookMeta } from '../data-source/interface';
import { Toolbar, type ToolbarFocusHandle } from './toolbar';
import { FilterPopover } from './filter-popover';
import { transform_progress_label, upsert_filter } from './transform-ui-model';
import { SheetTabs } from './sheet-tabs';
import {
    GridShell,
    type EditingStatus,
    type EditingHandle,
    type GridFocusHandle,
    type PendingPreviewScroll,
} from './grid-shell';
import {
    clamp_sheet_index,
    normalize_per_file_state,
    trim_sheet_state_array,
    sanitize_transform_state,
} from './sheet-state';
import { column_letter } from './grid-model';
import {
    create_column_projection,
    hide_all_columns,
    sanitize_column_visibility_state,
    show_all_columns,
    toggle_source_column,
} from './column-projection';
import { vscode_api, use_state_sync } from './use-state-sync';
import './styles.css';

type ColumnVisibilityUpdater = (
    current: SheetColumnVisibilityState | undefined,
    column_count: number,
    schema: string,
) => SheetColumnVisibilityState | undefined;

type TransformOrigin = 'grid' | 'toolbar' | 'restore';

const GRID_FOCUS_RESTORE_MAX_ATTEMPTS = 8;
const GRID_FOCUS_RESTORE_RETRY_MS = 16;

function column_visibility_equal(
    left: SheetColumnVisibilityState | undefined,
    right: SheetColumnVisibilityState | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.schema !== right.schema) return false;
    return JSON.stringify(left) === JSON.stringify(right);
}

function transforms_semantically_equal(
    left: SheetTransformState | undefined,
    right: SheetTransformState | undefined,
): boolean {
    if (!transform_has_entries(left) && !transform_has_entries(right)) return true;
    if (!left || !right) return false;
    if (JSON.stringify(left.sort) !== JSON.stringify(right.sort)) return false;
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
            return {
                ...base,
                value: entry.value ?? '',
                secondValue: entry.operator === 'between'
                    ? entry.secondValue ?? ''
                    : undefined,
                caseSensitive: entry.caseSensitive,
            };
        })
        .sort((a, b) => a.colIndex - b.colIndex);
    return JSON.stringify(semantic_filters(left.filters))
        === JSON.stringify(semantic_filters(right.filters));
}

/**
 * Webview root (Phase C). Consumes the paginated `sheetMeta`/`metaReload`
 * protocol (structure only — cells stream in later via the row loader inside
 * {@link GridShell}) and mounts the Glide canvas grid keyed by sheet index so a
 * sheet switch remounts (and clears) the loader. Editing, selection, row
 * resize, and canvas-measured auto-fit are restored in Phases D/E; here the grid
 * is read-only plain text + bold/italic.
 */
export function App(): React.JSX.Element {
    const [meta, set_meta] = useState<WorkbookMeta | null>(null);
    const [generation, set_generation] = useState(0);
    // Bumped on every `sheetMeta` (a fresh document load — including the preview
    // pane reusing its panel for a different file). Folded into the GridShell key
    // so the row loader remounts clean; a new file can otherwise collide with the
    // previous one's generation (both start at 1) and surface stale cached pages.
    const [load_epoch, set_load_epoch] = useState(0);
    const [active_sheet_index, set_active_sheet_index] = useState(0);
    const [show_formatting, set_show_formatting] = useState(true);
    const [vertical_tabs, set_vertical_tabs] = useState(false);
    const [column_widths, set_column_widths] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [column_visibility, set_column_visibility] = useState<
        (SheetColumnVisibilityState | undefined)[]
    >([]);
    const [row_heights, set_row_heights] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [auto_fit_active, set_auto_fit_active] = useState<boolean[]>([]);
    const [auto_fit_snapshot, set_auto_fit_snapshot] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [truncation_message, set_truncation_message] = useState<string | null>(null);
    const [preview_mode, set_preview_mode] = useState(false);
    const [csv_editable, set_csv_editable] = useState(false);
    const [csv_editing_supported, set_csv_editing_supported] = useState(false);
    const [edit_mode, set_edit_mode] = useState(false);
    const [edit_session_pending, set_edit_session_pending] = useState(false);
    const [transforms, set_transforms] = useState<
        (SheetTransformState | undefined)[]
    >([]);
    const [applied_transforms, set_applied_transforms] = useState<
        (SheetTransformState | undefined)[]
    >([]);
    const [effective_row_counts, set_effective_row_counts] = useState<number[]>([]);
    const [pending_transforms, set_pending_transforms] = useState<boolean[]>([]);
    const [pending_transform_labels, set_pending_transform_labels] = useState<string[]>([]);
    const [pending_excel_header, set_pending_excel_header] = useState<string | null>(null);
    const [filter_editor, set_filter_editor] = useState<{
        column_index: number;
        anchor: { left: number; top: number };
        restore_focus: () => void;
        origin: Exclude<TransformOrigin, 'restore'>;
    } | null>(null);
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
    // Pending edits restored from per-file state, fed to GridShell on (re)mount so
    // unsaved work survives a webview reload. CSV is single-sheet, so this flat map
    // belongs to the one editable sheet.
    const [initial_edits, set_initial_edits] = useState<
        Record<string, string | { value: string; base: string }> | undefined
    >(undefined);
    // Conflict signature the user dismissed ("Keep All"); the banner reappears only
    // if a *different* set of cells later conflicts.
    const [dismissed_conflict_signature, set_dismissed_conflict_signature] =
        useState<string | null>(null);

    const state_ref = useRef<PerFileState>({});
    // GridShell populates this with imperative save/discard actions (the dirty map
    // lives next to the loader); App calls them from the toolbar + conflict banner.
    const editing_ref = useRef<EditingHandle | null>(null);
    // GridShell populates this with a measure function returning fitted column
    // widths (null when nothing is loaded); App calls it from the auto-fit toggle.
    const auto_fit_ref = useRef<(() => Record<number, number> | null) | null>(null);
    // True between posting a save (from the exit dialog) and its saveResult, so a
    // successful save then completes the deferred exit from edit mode.
    const pending_exit_ref = useRef(false);
    const pending_exit_save_succeeded_ref = useRef(false);
    const auto_fit_active_ref = useRef<boolean[]>([]);
    const auto_fit_snapshot_ref = useRef<
        (Record<number, number> | undefined)[]
    >([]);
    const transform_request_seq_ref = useRef(0);
    const excel_header_request_seq_ref = useRef(0);
    const pending_excel_header_ref = useRef<string | null>(null);
    const meta_ref = useRef<WorkbookMeta | null>(null);
    const pending_transform_request_ids_ref = useRef<(string | undefined)[]>([]);
    const pending_transform_states_ref = useRef<(SheetTransformState | undefined)[]>([]);
    const pending_transform_origins_ref = useRef<(TransformOrigin | undefined)[]>([]);
    const transform_applied_for_source_ref = useRef<boolean[]>([]);
    const generation_ref = useRef(1);
    const source_generation_ref = useRef(1);
    const document_epoch_ref = useRef(0);
    const preview_mode_ref = useRef(false);
    const preview_scroll_sequence_ref = useRef(0);
    const pending_preview_scroll_ref = useRef<PendingPreviewScroll | null>(null);
    const last_preview_visible_row_ref = useRef<number | null>(null);
    const filter_restore_timer_ref = useRef<number | undefined>(undefined);
    const grid_focus_ref = useRef<GridFocusHandle | null>(null);
    const toolbar_focus_ref = useRef<ToolbarFocusHandle | null>(null);

    const { persist_immediate } = use_state_sync(state_ref);

    const request_transform = useCallback((
        sheet_index: number,
        state: SheetTransformState,
        intent: TransformIntent,
        origin: TransformOrigin = 'toolbar',
    ) => {
        const request_id = `${sheet_index}:${++transform_request_seq_ref.current}`;
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
        vscode_api.postMessage({
            type: 'setTransform',
            sheetIndex: sheet_index,
            state,
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
            intent,
        });
    }, []);

    const release_edit_session = useCallback(() => {
        vscode_api.postMessage({ type: 'releaseEditSession' });
    }, []);

    const leave_edit_mode = useCallback(() => {
        set_edit_mode(false);
        release_edit_session();
    }, [release_edit_session]);

    const discard_edit_session = useCallback(() => {
        set_edit_mode(false);
        vscode_api.postMessage({ type: 'discardEditSession' });
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

            if (msg.type === 'sheetMeta') {
                document_epoch_ref.current += 1;
                set_grid_focus_restore(null);
                set_toolbar_focus_restore(null);
                last_preview_visible_row_ref.current = null;
                clear_pending_preview_scroll();
                preview_mode_ref.current = msg.previewMode ?? false;
                meta_ref.current = msg.meta;
                set_meta(msg.meta);
                pending_excel_header_ref.current = null;
                set_pending_excel_header(null);
                set_filter_editor(null);
                set_generation(msg.generation);
                generation_ref.current = msg.generation;
                source_generation_ref.current = msg.sourceGeneration;
                set_load_epoch((n) => n + 1);
                set_source_epoch((n) => n + 1);
                auto_fit_active_ref.current = [];
                auto_fit_snapshot_ref.current = [];
                set_auto_fit_active([]);
                set_auto_fit_snapshot([]);
                const s = normalize_per_file_state(
                    msg.state,
                    msg.meta.sheets.map((sheet) => sheet.name)
                );
                const normalized_transforms = s.transforms;
                s.transforms = msg.meta.sheets.map((sheet, index) =>
                    sanitize_transform_state(
                        normalized_transforms?.[index],
                        sheet.columnCount,
                        transform_schema_for_sheet(sheet),
                    ));
                const transforms_were_sanitized =
                    JSON.stringify(normalized_transforms ?? [])
                    !== JSON.stringify(s.transforms);
                const normalized_visibility = s.columnVisibility;
                s.columnVisibility = msg.meta.sheets.map((sheet, index) =>
                    sanitize_column_visibility_state(
                        normalized_visibility?.[index],
                        sheet.columnCount,
                        transform_schema_for_sheet(sheet),
                    ));
                const visibility_was_sanitized =
                    JSON.stringify(normalized_visibility ?? [])
                    !== JSON.stringify(s.columnVisibility);
                set_active_sheet_index(s.activeSheetIndex ?? 0);
                set_column_widths(s.columnWidths ?? []);
                set_column_visibility(s.columnVisibility ?? []);
                set_row_heights(s.rowHeights ?? []);
                set_transforms(s.transforms ?? []);
                set_applied_transforms((s.transforms ?? []).map((state) => (
                    state && !transform_is_active(state) ? state : undefined
                )));
                set_effective_row_counts(msg.meta.sheets.map((sheet) => sheet.rowCount));
                set_pending_transforms([]);
                set_pending_transform_labels([]);
                pending_transform_request_ids_ref.current = [];
                pending_transform_states_ref.current = [];
                pending_transform_origins_ref.current = [];
                transform_applied_for_source_ref.current = [];

                const tab_orient = s.tabOrientation ?? null;
                set_vertical_tabs(
                    tab_orient !== null
                        ? tab_orient === 'vertical'
                        : msg.defaultTabOrientation === 'vertical'
                );
                state_ref.current = s;
                if (transforms_were_sanitized || visibility_was_sanitized) {
                    persist_immediate();
                }
                set_truncation_message(msg.truncationMessage ?? null);
                set_preview_mode(msg.previewMode ?? false);
                const can_edit = msg.csvEditable ?? false;
                set_csv_editable(can_edit);
                set_csv_editing_supported(msg.csvEditingSupported ?? false);
                // A fresh document is read-only unless it carries restored pending
                // edits, in which case we re-enter edit mode and feed them to the
                // GridShell (which remounts via its key, reading initial_edits once).
                const restored_edits = s.pendingEdits;
                set_initial_edits(restored_edits);
                set_edit_mode(!!restored_edits && can_edit);
                set_edit_session_pending(false);
                set_editing_status(null);
                set_dismissed_conflict_signature(null);
                pending_exit_ref.current = false;
                pending_exit_save_succeeded_ref.current = false;
            }

            if (msg.type === 'metaReload') {
                const previous_sheets = new Map(
                    (meta_ref.current?.sheets ?? []).map((sheet) => [sheet.name, sheet]),
                );
                const header_changed = new Set<number>();
                msg.meta.sheets.forEach((sheet, index) => {
                    const previous = previous_sheets.get(sheet.name);
                    if (
                        previous
                        && previous.excelFirstRowHeader?.active
                            !== sheet.excelFirstRowHeader?.active
                    ) {
                        header_changed.add(index);
                    }
                });
                document_epoch_ref.current += 1;
                set_grid_focus_restore(null);
                set_toolbar_focus_restore(null);
                if (
                    preview_mode_ref.current
                    && pending_preview_scroll_ref.current === null
                    && last_preview_visible_row_ref.current !== null
                ) {
                    queue_preview_scroll(last_preview_visible_row_ref.current);
                }
                meta_ref.current = msg.meta;
                set_meta(msg.meta);
                pending_excel_header_ref.current = null;
                set_pending_excel_header(null);
                set_filter_editor(null);
                set_generation(msg.generation);
                generation_ref.current = msg.generation;
                source_generation_ref.current = msg.sourceGeneration;
                set_edit_session_pending(false);
                set_source_epoch((n) => n + 1);
                auto_fit_active_ref.current = [];
                auto_fit_snapshot_ref.current = [];
                set_auto_fit_active([]);
                set_auto_fit_snapshot([]);
                const sheet_count = msg.meta.sheets.length;

                set_column_widths((prev) =>
                    trim_sheet_state_array(prev, sheet_count)
                );
                set_row_heights((prev) =>
                    trim_sheet_state_array(prev, sheet_count).map((value, index) => (
                        header_changed.has(index) ? undefined : value
                    ))
                );
                set_effective_row_counts(msg.meta.sheets.map((sheet) => sheet.rowCount));
                set_pending_transforms([]);
                set_pending_transform_labels([]);
                pending_transform_request_ids_ref.current = [];
                pending_transform_states_ref.current = [];
                pending_transform_origins_ref.current = [];
                transform_applied_for_source_ref.current = [];
                // A header toggle only moves row 0 in or out of the body; column
                // indices are stable, so descriptors saved under the sheet's old
                // fingerprint are migrated to the new one instead of discarded.
                const migrate_schema = <T extends { schema?: string }>(
                    value: T | undefined,
                    sheet: (typeof msg.meta.sheets)[number],
                    index: number,
                ): T | undefined => {
                    if (!value || !header_changed.has(index)) return value;
                    const previous = previous_sheets.get(sheet.name);
                    if (
                        !previous
                        || value.schema !== transform_schema_for_sheet(previous)
                    ) {
                        return value;
                    }
                    return { ...value, schema: transform_schema_for_sheet(sheet) };
                };
                const next_transforms = msg.meta.sheets.map((sheet, index) =>
                    sanitize_transform_state(
                        migrate_schema(
                            state_ref.current.transforms?.[index],
                            sheet,
                            index,
                        ),
                        sheet.columnCount,
                        transform_schema_for_sheet(sheet),
                    ));
                const next_column_visibility = msg.meta.sheets.map((sheet, index) =>
                    sanitize_column_visibility_state(
                        migrate_schema(
                            state_ref.current.columnVisibility?.[index],
                            sheet,
                            index,
                        ),
                        sheet.columnCount,
                        transform_schema_for_sheet(sheet),
                    ));
                set_transforms(next_transforms);
                set_column_visibility(next_column_visibility);
                set_applied_transforms(next_transforms.map((state) => (
                    state && !transform_is_active(state) ? state : undefined
                )));

                const next_active_sheet_index = clamp_sheet_index(
                    active_sheet_index,
                    sheet_count
                );
                set_active_sheet_index(next_active_sheet_index);

                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: trim_sheet_state_array(
                        state_ref.current.columnWidths,
                        sheet_count
                    ),
                    rowHeights: trim_sheet_state_array(
                        state_ref.current.rowHeights,
                        sheet_count
                    ).map((value, index) => (
                        header_changed.has(index) ? undefined : value
                    )),
                    scrollPosition: trim_sheet_state_array(
                        state_ref.current.scrollPosition,
                        sheet_count
                    ).map((value, index) => (
                        header_changed.has(index) ? undefined : value
                    )),
                    transforms: next_transforms,
                    columnVisibility: next_column_visibility,
                    activeSheetIndex: next_active_sheet_index,
                };
                set_truncation_message(msg.truncationMessage ?? null);
                if (msg.csvEditable !== undefined) {
                    set_csv_editable(msg.csvEditable);
                }
                if (msg.csvEditingSupported !== undefined) {
                    set_csv_editing_supported(msg.csvEditingSupported);
                }
                persist_immediate();
            }

            if (msg.type === 'excelFirstRowHeaderError') {
                if (pending_excel_header_ref.current !== msg.requestId) return;
                pending_excel_header_ref.current = null;
                set_pending_excel_header(null);
                vscode_api.postMessage({
                    type: 'showWarning',
                    message: `Could not change the header row: ${msg.error}`,
                });
            }

            if (
                msg.type === 'scrollToRow'
                && preview_mode_ref.current
                && Number.isFinite(msg.row)
            ) {
                queue_preview_scroll(msg.row);
            }

            if (msg.type === 'transformApplied') {
                if (
                    pending_transform_request_ids_ref.current[msg.sheetIndex]
                    !== msg.requestId
                ) {
                    return;
                }
                const origin = pending_transform_origins_ref.current[msg.sheetIndex];
                pending_transform_request_ids_ref.current[msg.sheetIndex] = undefined;
                pending_transform_states_ref.current[msg.sheetIndex] = undefined;
                pending_transform_origins_ref.current[msg.sheetIndex] = undefined;
                if (origin === 'grid') {
                    set_grid_focus_restore({
                        sheet_index: msg.sheetIndex,
                        generation: msg.generation,
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
                set_generation(msg.generation);
                generation_ref.current = msg.generation;
                transform_applied_for_source_ref.current[msg.sheetIndex] = true;
                set_effective_row_counts((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = msg.rowCount;
                    return next;
                });
                const next_transforms = [
                    ...(state_ref.current.transforms ?? transforms),
                ];
                next_transforms[msg.sheetIndex] = transform_has_entries(msg.state)
                    ? msg.state
                    : undefined;
                state_ref.current = {
                    ...state_ref.current,
                    transforms: next_transforms,
                };
                set_transforms(next_transforms);
                set_applied_transforms((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = transform_has_entries(msg.state)
                        ? msg.state
                        : undefined;
                    return next;
                });
                // A transform changes the population sampled by auto-fit. Keep
                // current widths, but discard the toggle/snapshot so restoring
                // cannot apply a stale pre-transform measurement.
                set_auto_fit_active((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = false;
                    return next;
                });
                set_auto_fit_snapshot((prev) => {
                    const next = [...prev];
                    next[msg.sheetIndex] = undefined;
                    return next;
                });
                if (msg.error) {
                    vscode_api.postMessage({
                        type: 'showWarning',
                        message: `Could not apply sort/filter: ${msg.error}`,
                    });
                }
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [
        active_sheet_index,
        clear_pending_preview_scroll,
        persist_immediate,
        queue_preview_scroll,
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
        vscode_api.postMessage({ type: 'ready' });
        return () => {
            release_edit_session();
        };
    }, []);

    // Recompute persisted transforms against each freshly loaded source. The
    // host intentionally drops permutations on reload because matching schema
    // does not imply matching values.
    useEffect(() => {
        if (!meta || preview_mode || edit_mode) return;
        const sheet = meta.sheets[active_sheet_index];
        if (!sheet) return;
        if (
            transform_applied_for_source_ref.current[active_sheet_index]
            || pending_transform_request_ids_ref.current[active_sheet_index]
        ) {
            return;
        }
        const state = sanitize_transform_state(
            state_ref.current.transforms?.[active_sheet_index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
        );
        if (state && transform_is_active(state)) {
            request_transform(active_sheet_index, state, 'restore', 'restore');
        }
    }, [
        source_epoch,
        meta,
        preview_mode,
        edit_mode,
        active_sheet_index,
        request_transform,
    ]);

    const handle_sheet_select = useCallback(
        (sheet_index: number) => {
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

    const handle_toggle_formatting = useCallback(() => {
        set_show_formatting((prev) => !prev);
    }, []);

    const handle_toggle_excel_header = useCallback(() => {
        const sheet = meta?.sheets[active_sheet_index];
        const header = sheet?.excelFirstRowHeader;
        if (!sheet || !header?.available || pending_excel_header_ref.current) return;
        const request_id = `header:${++excel_header_request_seq_ref.current}`;
        pending_excel_header_ref.current = request_id;
        set_pending_excel_header(request_id);
        vscode_api.postMessage({
            type: 'setExcelFirstRowHeader',
            sheetIndex: active_sheet_index,
            sheetName: sheet.name,
            enabled: !header.active,
            requestId: request_id,
            generation: generation_ref.current,
            sourceGeneration: source_generation_ref.current,
        });
    }, [active_sheet_index, meta]);

    const handle_toggle_edit_mode = useCallback(() => {
        if (!edit_mode) {
            if (edit_session_pending) return;
            if (
                transform_is_active(transforms[active_sheet_index])
                || pending_transforms[active_sheet_index]
            ) {
                vscode_api.postMessage({
                    type: 'showWarning',
                    message: 'Clear sorting and filters before entering edit mode.',
                });
                return;
            }
            set_edit_session_pending(true);
            vscode_api.postMessage({ type: 'requestEditSession' });
            return;
        }
        // Leaving edit mode with unsaved work: defer to a host Save/Discard/Cancel
        // dialog (handled below); otherwise exit immediately.
        if (editing_ref.current?.has_uncommitted_changes()) {
            vscode_api.postMessage({ type: 'showSaveDialog' });
            return;
        }
        leave_edit_mode();
    }, [
        edit_mode,
        leave_edit_mode,
        transforms,
        pending_transforms,
        edit_session_pending,
        active_sheet_index,
    ]);

    const handle_transform_change = useCallback(
        (next_state: SheetTransformState, origin: TransformOrigin): boolean => {
            if (edit_mode || edit_session_pending || preview_mode) return false;
            const schema = meta?.sheets[active_sheet_index]
                ? transform_schema_for_sheet(meta.sheets[active_sheet_index])
                : undefined;
            const column_count = meta?.sheets[active_sheet_index]?.columnCount ?? 0;
            const sanitized = sanitize_transform_state(
                { ...next_state, schema },
                column_count,
                schema,
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
            );
            if (transforms_semantically_equal(current, sanitized)) return false;
            request_transform(active_sheet_index, sanitized, 'user', origin);
            return true;
        },
        [
            active_sheet_index,
            edit_mode,
            edit_session_pending,
            meta,
            preview_mode,
            request_transform,
        ],
    );

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
            edit_mode
            || edit_session_pending
            || preview_mode
            || pending_transforms[active_sheet_index]
        ) return;
        set_filter_editor({ column_index, anchor, restore_focus, origin });
    }, [
        active_sheet_index,
        edit_mode,
        edit_session_pending,
        pending_transforms,
        preview_mode,
    ]);

    const open_grid_filter_editor = useCallback((
        column_index: number,
        anchor: { left: number; top: number },
        restore_focus: () => void,
    ) => {
        open_filter_editor(column_index, anchor, restore_focus, 'grid');
    }, [open_filter_editor]);

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

    const handle_cancel_transform = useCallback(() => {
        const previous = applied_transforms[active_sheet_index]
            ?? {
                sort: [],
                filters: [],
                schema: meta?.sheets[active_sheet_index]
                    ? transform_schema_for_sheet(meta.sheets[active_sheet_index])
                    : undefined,
            };
        const current = pending_transform_states_ref.current[active_sheet_index]
            ?? state_ref.current.transforms?.[active_sheet_index];
        if (transforms_semantically_equal(current, previous)) return;
        request_transform(active_sheet_index, previous, 'cancel');
    }, [
        active_sheet_index,
        applied_transforms,
        meta,
        request_transform,
    ]);

    // React to the host's save-dialog choice (from the exit flow) and to the save
    // outcome. GridShell separately clears the dirty map on a successful save; here
    // we only complete a deferred exit from edit mode.
    //
    // Reset all pending-exit bookkeeping and leave edit mode. Called once a
    // save-on-exit has succeeded and no uncommitted work remains. Refs and
    // setters are stable, so this keeps one identity for the component's life.
    const finish_pending_exit = useCallback(() => {
        pending_exit_ref.current = false;
        pending_exit_save_succeeded_ref.current = false;
        leave_edit_mode();
    }, [leave_edit_mode]);

    // A deferred exit completes once the save acked and no uncommitted work (dirty
    // map or open overlay) remains. Shared by the saveResult handler and the
    // editing-status effect so the predicate can't drift between them.
    const can_finish_pending_exit = useCallback(
        () =>
            pending_exit_ref.current &&
            pending_exit_save_succeeded_ref.current &&
            !(editing_ref.current?.has_uncommitted_changes() ?? false),
        [],
    );

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;
            if (msg.type === 'editSessionResult') {
                set_edit_session_pending(false);
                if (msg.granted) {
                    if (msg.pendingEdits) {
                        set_initial_edits(msg.pendingEdits);
                        set_load_epoch((n) => n + 1);
                    }
                    set_edit_mode(true);
                } else {
                    pending_exit_ref.current = false;
                    pending_exit_save_succeeded_ref.current = false;
                    set_edit_mode(false);
                }
            } else if (msg.type === 'saveDialogResult') {
                if (msg.choice === 'save') {
                    const editing = editing_ref.current;
                    // request_save() has side effects, so it must be evaluated first.
                    if (editing?.request_save() || editing?.has_uncommitted_changes()) {
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
                if (pending_exit_ref.current) {
                    if (msg.success) {
                        pending_exit_save_succeeded_ref.current = true;
                        // If everything is already clean, finish now; otherwise the
                        // editing-status effect completes the exit once the dirty
                        // map and any open overlay later go clean.
                        if (can_finish_pending_exit()) {
                            finish_pending_exit();
                        }
                    } else if (!pending_exit_save_succeeded_ref.current) {
                        pending_exit_ref.current = false;
                    }
                }
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [
        can_finish_pending_exit,
        discard_edit_session,
        finish_pending_exit,
        leave_edit_mode,
    ]);

    // If editing becomes unavailable (e.g. a reload disables CSV editing), leave
    // edit mode so the toolbar/banner don't dangle.
    useEffect(() => {
        if (edit_mode && !csv_editable) leave_edit_mode();
    }, [edit_mode, csv_editable, leave_edit_mode]);

    // GridShell owns the dirty map (next to the loader); it reports status up so
    // the toolbar dirty dot, pending-edit persistence, and conflict banner —
    // App-level concerns — can react.
    const handle_editing_change = useCallback((status: EditingStatus) => {
        set_editing_status(status);
    }, []);

    // Single completion trigger for a save-on-exit. GridShell now reports both the
    // committed-dirty state (is_dirty) and the open overlay's dirtiness
    // (has_live_uncommitted), so this effect re-runs on every transition that can
    // make editing clean — no polling interval needed.
    useEffect(() => {
        if (can_finish_pending_exit()) {
            finish_pending_exit();
        }
    }, [editing_status?.is_dirty, editing_status?.has_live_uncommitted]);

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
        if (!sheet) return;
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
        vscode_api.postMessage({
            type: 'setColumnVisibility',
            sheetIndex: active_sheet_index,
            state: next_sheet_visibility,
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
            // Deactivate auto-fit if it was active (keep current widths, discard snapshot)
            deactivate_auto_fit_for_sheet(active_sheet_index);
        },
        [active_sheet_index, persist_immediate, deactivate_auto_fit_for_sheet]
    );

    const handle_row_resize = useCallback(
        (row: number, height: number) => {
            set_row_heights((prev) => {
                const next = [...prev];
                const sheet_heights = { ...(next[active_sheet_index] ?? {}) };
                sheet_heights[row] = height;
                next[active_sheet_index] = sheet_heights;
                state_ref.current = {
                    ...state_ref.current,
                    rowHeights: [...next],
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet_index, persist_immediate]
    );

    const handle_toggle_auto_fit = useCallback(() => {
        if (auto_fit_active[active_sheet_index]) {
            // Deactivate: restore snapshotted widths.
            const snapshot = auto_fit_snapshot[active_sheet_index];
            set_column_widths((prev) => {
                const next = [...prev];
                next[active_sheet_index] = snapshot;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            set_auto_fit_active((prev) => {
                const next = [...prev];
                next[active_sheet_index] = false;
                auto_fit_active_ref.current = next;
                return next;
            });
            set_auto_fit_snapshot((prev) => {
                const next = [...prev];
                next[active_sheet_index] = undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
        } else {
            // Activate: measure the grid's loaded rows and apply the fitted
            // widths, snapshotting the current widths so deactivation restores
            // them. If nothing is loaded there's nothing to measure — leave off.
            const fitted = auto_fit_ref.current?.();
            if (!fitted) return;
            const current_widths = column_widths[active_sheet_index];
            set_auto_fit_snapshot((prev) => {
                const next = [...prev];
                next[active_sheet_index] = current_widths
                    ? { ...current_widths }
                    : undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
            set_column_widths((prev) => {
                const next = [...prev];
                next[active_sheet_index] = {
                    ...(next[active_sheet_index] ?? {}),
                    ...fitted,
                };
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            set_auto_fit_active((prev) => {
                const next = [...prev];
                next[active_sheet_index] = true;
                auto_fit_active_ref.current = next;
                return next;
            });
        }
    }, [
        active_sheet_index,
        auto_fit_active,
        auto_fit_snapshot,
        column_widths,
        persist_immediate,
    ]);

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

    if (!meta) {
        return <div className="loading">Loading...</div>;
    }

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = meta.sheets.map((s) => s.name);
    const has_multiple_sheets = meta.sheets.length > 1;
    const effective_vertical_tabs = vertical_tabs && has_multiple_sheets;
    const current_transform = transforms[active_sheet_index] ?? EMPTY_TRANSFORM;
    const visible_transform =
        edit_mode || preview_mode ? EMPTY_TRANSFORM : current_transform;
    const applied_transform = applied_transforms[active_sheet_index];
    const transform_active = transform_is_active(applied_transform);
    const any_transform_pending = pending_transforms.some(Boolean);
    const has_hidden_columns =
        current_column_projection.visible_to_source.length
        < current_sheet.columnCount;
    const merges_flattened =
        current_sheet.merges.length > 0
        && (transform_active || has_hidden_columns);
    const transform_pending = pending_transforms[active_sheet_index] ?? false;
    const excel_header = current_sheet.excelFirstRowHeader;
    const excel_header_pending = pending_excel_header !== null;
    const excel_header_disabled = !!excel_header && (
        !excel_header.available
        || any_transform_pending
        || excel_header_pending
    );
    const excel_header_disabled_reason = !excel_header?.available
        ? 'This sheet has no first row to use as column names.'
        : excel_header_pending
        ? 'Updating column names…'
        : 'Wait for sorting and filtering to finish.';
    const effective_row_count =
        effective_row_counts[active_sheet_index] ?? current_sheet.rowCount;
    const visibility_reset_key = [
        load_epoch,
        active_sheet_index,
        transform_schema_for_sheet(current_sheet),
    ].join(':');
    const no_visible_columns =
        current_column_projection.visible_to_source.length === 0;

    // Conflict banner: a stable signature of the conflicted cell set, so dismissing
    // it ("Keep All") sticks until a *different* set of cells drifts.
    const conflicted_keys = editing_status?.conflicted ?? [];
    const conflict_signature = [...conflicted_keys].sort().join(',');
    const show_conflict_banner =
        edit_mode &&
        conflicted_keys.length > 0 &&
        conflict_signature !== dismissed_conflict_signature;

    const grid = (
        <GridShell
            key={`${active_sheet_index}:${load_epoch}:${generation}`}
            sheet_meta={current_sheet}
            sheet_index={active_sheet_index}
            generation={generation}
            row_count={effective_row_count}
            transformed={transform_active}
            show_formatting={show_formatting}
            column_projection={current_column_projection}
            column_widths={column_widths[active_sheet_index] ?? {}}
            on_column_resize={handle_column_resize}
            row_heights={transform_active ? {} : (row_heights[active_sheet_index] ?? {})}
            on_row_resize={handle_row_resize}
            merges={merges_flattened ? [] : current_sheet.merges}
            preview_mode={preview_mode}
            edit_mode={edit_mode}
            csv_editable={csv_editable}
            initial_edits={initial_edits}
            on_editing_change={handle_editing_change}
            editing_ref={editing_ref}
            auto_fit_ref={auto_fit_ref}
            grid_focus_ref={grid_focus_ref}
            pending_preview_scroll={pending_preview_scroll}
            on_preview_scroll_applied={handle_preview_scroll_applied}
            on_preview_visible_row_change={handle_preview_visible_row_change}
            transform_state={visible_transform}
            transform_sections={!edit_mode && !edit_session_pending && !preview_mode}
            transform_pending={transform_pending}
            on_transform_change={handle_grid_transform_change}
            on_open_filter={open_grid_filter_editor}
            on_hide_column={handle_toggle_column}
            on_focus_columns={focus_columns_trigger}
        />
    );

    return (
        <div className={`viewer ${effective_vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                ref={toolbar_focus_ref}
                row_count={effective_row_count}
                source_row_count={current_sheet.rowCount}
                transform={visible_transform}
                transform_disabled={edit_mode || edit_session_pending || preview_mode}
                transform_pending={transform_pending}
                transform_progress={pending_transform_labels[active_sheet_index]}
                column_names={column_names}
                merges_flattened={merges_flattened}
                on_transform_change={handle_toolbar_transform_change}
                on_edit_filter={(entry, trigger) => {
                    const rect = trigger.getBoundingClientRect();
                    open_filter_editor(
                        entry.colIndex,
                        { left: rect.left, top: rect.bottom + 4 },
                        () => trigger.focus(),
                        'toolbar',
                    );
                }}
                on_cancel_transform={handle_cancel_transform}
                show_formatting={show_formatting}
                on_toggle_formatting={handle_toggle_formatting}
                show_formatting_button={meta.hasFormatting}
                show_excel_header_button={excel_header !== undefined}
                excel_header_active={excel_header?.active ?? false}
                excel_header_automatic={excel_header?.mode === 'auto'}
                on_toggle_excel_header={handle_toggle_excel_header}
                excel_header_disabled={excel_header_disabled}
                excel_header_disabled_reason={excel_header_disabled_reason}
                vertical_tabs={vertical_tabs}
                on_toggle_tab_orientation={handle_toggle_tab_orientation}
                show_vertical_tabs_button={has_multiple_sheets}
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
                auto_fit_disabled={no_visible_columns || transform_pending}
                auto_fit_disabled_reason={
                    no_visible_columns
                        ? current_sheet.columnCount === 0
                            ? 'No columns are available to auto-fit.'
                            : 'Show at least one column before using auto-fit.'
                        : 'Wait for sorting and filtering to finish.'
                }
                edit_mode={edit_mode}
                is_dirty={editing_status?.is_dirty ?? false}
                on_toggle_edit_mode={handle_toggle_edit_mode}
                show_edit_button={csv_editing_supported}
                edit_disabled={
                    !edit_mode && (
                        edit_session_pending
                        || transform_active
                        || transform_pending
                    )
                }
                edit_disabled_reason={
                    edit_session_pending
                        ? 'Waiting to enter edit mode.'
                        : transform_pending
                        ? 'Wait for sorting and filtering to finish.'
                        : 'Clear sorting and filters before editing.'
                }
            />
            {filter_editor && (
                <FilterPopover
                    key={filter_editor.column_index}
                    column_index={filter_editor.column_index}
                    column_name={column_names[filter_editor.column_index]
                        ?? `Column ${filter_editor.column_index + 1}`}
                    filters={visible_transform.filters}
                    anchor={filter_editor.anchor}
                    on_apply={apply_filter_editor}
                    on_cancel={(reason) => close_filter_editor(
                        reason === 'escape' || reason === 'explicit',
                    )}
                />
            )}
            {truncation_message && (
                <div className="truncation-banner">{truncation_message}{csv_editing_supported && !csv_editable ? '. Editing is disabled for truncated files.' : ''}</div>
            )}
            {show_conflict_banner && (
                <div className="conflict-banner">
                    File changed externally. {conflicted_keys.length} edit
                    {conflicted_keys.length === 1 ? '' : 's'} may be affected —
                    highlighted cells show conflicts.
                    <div className="conflict-banner-actions">
                        <button
                            onClick={() =>
                                set_dismissed_conflict_signature(conflict_signature)
                            }
                        >
                            Keep All
                        </button>
                        <button
                            onClick={() => editing_ref.current?.discard_conflicted()}
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
            {effective_vertical_tabs ? (
                <div className="content-area">
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={true}
                    />
                    {grid}
                </div>
            ) : (
                <>
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={false}
                    />
                    {grid}
                </>
            )}
        </div>
    );
}
