import { cell_key, parse_cell_key } from '../cell-key';
import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type MutableRefObject,
} from 'react';
import {
    CompactSelection,
    DataEditor,
    GridCellKind,
    type CellClickedEventArgs,
    type CellEditSource,
    type DataEditorRef,
    type DrawHeaderCallback,
    type EditListItem,
    type GridCell,
    type GridColumn,
    type HeaderClickedEventArgs,
    type GridKeyEventArgs,
    type GridMouseEventArgs,
    type GridSelection,
    type Item,
    type ProvideEditorCallback,
    type Rectangle,
} from './glide-data-grid';
import type { RenderedCell, SheetMeta } from '../data-source/interface';
import {
    EMPTY_TRANSFORM,
    dirty_entry_value_dimension_present,
    latest_dirty_value_edit_order,
    type CellHighlightColor,
    type CellHighlightMutation,
    type CellHighlightSelection,
    type CsvDirtyMap,
    type CsvObservedFileBase,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type DisplayRowInterval,
    type HostMessage,
    type MergeRange,
    type ScrollPosition,
    type SheetCellHighlightState,
    type SheetTransformState,
    type SortDirection,
    type WorksheetTarget,
    type WorksheetPendingChanges,
} from '../types';
import {
    column_projections_equal,
    type ColumnProjection,
} from './column-projection';
import {
    build_grid_columns,
    column_letter,
    LAST_COLUMN_RESIZE_GUTTER_PX,
    MAX_AUTO_FIT_COLUMN_WIDTH_PX,
    MAX_COLUMN_WIDTH_PX,
} from './grid-model';
import { ContextMenu } from './context-menu';
import {
    cell_context_menu_items,
    has_distinct_copy_selection,
} from './cell-context-menu';
import {
    ColumnContextMenu,
    header_column_can_be_renamed,
    MultiColumnContextMenu,
} from './column-context-menu';
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
    max_copy_rows_for_columns,
} from './grid-copy-model';
import {
    resolve_nav,
    is_copy_key,
    move_sequential_cell,
    sequential_append_target_column,
} from './grid-nav-model';
import { move_active_cell } from './selection';
import { MergeIndex } from './merge-index';
import {
    build_grid_cell,
    cell_allows_wrapping,
    displayed_text,
    rich_cell_display_data,
    type CellEditOverlay,
} from './cell-renderer';

let last_value_edit_order = 0;
function next_value_edit_order(after_order = 0): number {
    const clock = Date.now() * 1_000;
    const next = Math.max(clock, last_value_edit_order + 1, after_order + 1);
    if (!Number.isSafeInteger(next)) {
        throw new RangeError('Pending edit order exceeds the safe integer range');
    }
    last_value_edit_order = next;
    return last_value_edit_order;
}
import { is_rich_text_cell, rich_text_cell_renderer } from './rich-text-cell-renderer';
import { parse_http_external_url } from '../external-url';
import type { CellHyperlink } from '../cell-content';
import { HyperlinkDialog, type HyperlinkDialogHandle } from './hyperlink-dialog';
import { RenameColumnDialog } from './rename-column-dialog';
import { committed_column_name } from '../column-name';
import {
    CELL_TOOLTIP_SHOW_DELAY_MS,
    cell_tooltip_content,
    cell_tooltip_position,
    link_open_hint,
    rich_text_overflows_cell,
    clamp_tooltip_text,
    text_overflows_cell,
} from './cell-overflow-model';
import { browserIsOSX } from './glide-data-grid/common/browser-detect.js';
import { count_lines, has_line_break } from './line-breaks';
import {
    use_editing,
    type CellValueEdit,
    type DirtyEntry,
    type HistoryCaptureOptions,
} from './use-editing';
import type { HistoryStore } from './history-store';
import type { HistoryChange } from './history-stack-model';
import { tail_removals_after_cancellation } from './pending-row-history';
import { commit_staged_transaction, type StagedMutation } from './staged-mutation';
import {
    cell_edit_text,
    cell_whole_style,
    dirty_value_edit_text,
    parse_cell_edit,
    type EditSyntax,
} from '../cell-edit-model';
import { format_xlsx_edit_preview } from '../spreadsheet-format';
import { MAX_SHEET_ROWS } from '../spreadsheet-safety';
import {
    xlsx_edit_writes_formula,
    xlsx_runs_require_inline_string,
} from '../xlsx-cell-value';
import { UNKNOWN_XLSX_FORMULA_RESULT } from '../xlsx-formula';
import {
    type FormulaSheetImpact,
} from '../formula-dependencies';
import {
    create_edit_session_store,
    type EditSessionStore,
} from './edit-session-store';
import {
    csv_save_operations_equal,
    is_valid_csv_save_lifecycle,
    remove_operation_owned_pending_edits,
    resolve_csv_save_hydration,
    save_lifecycle_correlation,
    save_operation_worksheet,
    terminal_csv_save_settles_operation,
} from './csv-save-lifecycle';
import {
    canvas_font,
    fit_column_widths,
    measurable_from_rendered,
    type MeasurableCell,
} from './fit-column-model';
import { CsvCellEditor, type CsvCellEditorProps } from './csv-cell-editor';
import {
    RowResizeOverlay,
    type RowResizeOverlayHandle,
} from './row-resize-overlay';
import { AppendDock } from './append-dock';
import {
    AppendComposer,
    EMPTY_APPEND_COMPOSER_DRAFT,
    type AppendComposerDraft,
} from './append-composer';
import { row_boundary_hit } from './row-resize-model';
import { read_overlay_editor_value } from './live-editor';

type LiveEdit = {
    kind: 'source';
    key: string;
    value: string;
    original: string;
} | {
    kind: 'pending';
    pendingRowId: string;
    sourceColumn: number;
    value: string;
    original: string;
};
import {
    changed_highlight_keys,
    changed_tint_keys,
    source_key_damage,
} from './grid-repaint-model';
import { expand_glide_selection } from './selection-glide';
import {
    grid_selection_contains_cell,
    highlight_selection_may_have_renderable_highlight,
    highlight_selection_from_grid,
    selected_display_row_intervals,
} from './highlight-selection-model';
import { highlight_rgba, history_flash_rgba } from './highlight-theme';
import {
    HISTORY_FLASH_DURATION_MS,
    begin_history_flash,
    history_flash_covers,
    history_flash_damage,
    resolve_history_focus,
    type HistoryFlash,
    type HistoryFocusOutcome,
    type PendingHistoryFocus,
} from './history-focus-model';
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

/** Module-level so the DataEditor prop is referentially stable. */
const custom_renderers = [rich_text_cell_renderer];

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

/**
 * Markdown serialization cache for `get_cell_content`'s overlay `edit_value`.
 * That callback is Glide's per-cell paint path, and re-serializing every
 * visible editable cell's runs each frame is measurable on wide sheets. Both
 * inputs — a dirty entry and a loaded cell — are immutable objects replaced
 * wholesale on change, so object identity is a sound cache key; module-level
 * because the WeakMap holds nothing alive. Markdown-only: plain sheets never
 * compute an edit_value here.
 */
const markdown_edit_text_cache = new WeakMap<object, string>();

/** Dirty entries and loaded cells are immutable, so the preview dies naturally
 * when either the edit changes or the row loader replaces its page. */
interface DirtyPresentation {
    readonly requires_rich: boolean;
    readonly display?: string;
}
const dirty_presentation_cache
    = new WeakMap<DirtyEntry, WeakMap<RenderedCell, DirtyPresentation>>();

function dirty_requires_rich_text(
    dirty: DirtyEntry,
    cell: RenderedCell | null | undefined,
): boolean {
    const runs = dirty.valueRuns?.runs;
    return runs !== undefined && xlsx_runs_require_inline_string(
        runs,
        cell ? cell_whole_style(cell) : undefined,
    );
}

function cached_dirty_presentation(
    dirty: DirtyEntry,
    cell: RenderedCell,
): DirtyPresentation {
    let by_cell = dirty_presentation_cache.get(dirty);
    if (!by_cell) {
        by_cell = new WeakMap();
        dirty_presentation_cache.set(dirty, by_cell);
    }
    const cached = by_cell.get(cell);
    if (cached) return cached;
    const requires_rich = dirty_requires_rich_text(dirty, cell);
    const display = cell.numberFormat
        ? format_xlsx_edit_preview(dirty.value, cell.numberFormat, {
            was_boolean: cell.rawType === 'boolean',
            was_iso_date: cell.xlsxIsoDate,
            force_text: requires_rich,
        })
        : undefined;
    const presentation = {
        requires_rich,
        ...(display !== undefined ? { display } : {}),
    };
    by_cell.set(cell, presentation);
    return presentation;
}

/**
 * What the undo menu will say this gesture was.
 *
 * Named from the gesture Glide reports rather than from what the cells ended up
 * containing: a paste of empty strings is still a paste to the user, and "Undo
 * Clear cells" for it would name an operation they did not perform.
 */
function edit_history_label(source: CellEditSource, count: number): string {
    switch (source) {
        case 'paste': return 'Paste';
        case 'fill': return 'Fill';
        case 'delete': return count === 1 ? 'Clear cell' : 'Clear cells';
        default: return count === 1 ? 'Edit cell' : 'Edit cells';
    }
}

function cached_markdown_edit_text(
    source: object,
    serialize: () => string,
): string {
    const hit = markdown_edit_text_cache.get(source);
    if (hit !== undefined) return hit;
    const text = serialize();
    markdown_edit_text_cache.set(source, text);
    return text;
}

function calculated_formula_display(
    result: string | undefined,
    show_formatting: boolean,
    cell: RenderedCell | null | undefined,
): string | undefined {
    if (
        result === undefined
        || !show_formatting
        || !cell?.numberFormat
        || result.startsWith(UNKNOWN_XLSX_FORMULA_RESULT)
    ) {
        return result;
    }
    return format_xlsx_edit_preview(result, cell.numberFormat, {
        was_boolean: false,
        was_iso_date: cell.xlsxIsoDate,
    });
}

/**
 * The value-edit half of a cell's paint overlay. Shared by the paint callback
 * and the hover-tooltip measurement so the two cannot disagree on what a dirty
 * cell displays (same rule as cell-renderer's renders_rich). Only a VALUE edit
 * replaces the displayed text — a link-only entry's `value` is the unedited
 * cell's raw text. Diff mode needs a trustworthy "before": a base_pending
 * entry's base is a placeholder until its page lands, so it shows the new
 * value alone. `xlsx_editing` enables both XLSX rich text and formula semantics;
 * CSV/TSV use the plain edit syntax and keep a leading `=` as literal text.
 */
function dirty_value_overlay_fields(
    dirty: DirtyEntry,
    diff_mode: boolean,
    show_formatting: boolean,
    cell: RenderedCell | null | undefined,
    xlsx_editing = false,
    calculated_formula_result?: string,
): Pick<
    CellEditOverlay,
    'dirty_value' | 'dirty_display' | 'dirty_rich' | 'diff_base'
        | 'formula_result_pending' | 'formula_result'
> | undefined {
    if (!dirty_entry_value_dimension_present(dirty)) return undefined;
    const dirty_runs = dirty.valueRuns?.runs;
    const retained_runs = dirty_runs && dirty_runs.length > 0 ? dirty_runs : undefined;
    const formula_edit = xlsx_editing
        && xlsx_edit_writes_formula(dirty.value, retained_runs);
    const formula_result_pending = formula_edit && calculated_formula_result === undefined;
    const presentation = !formula_edit && show_formatting && !diff_mode && cell
        && (cell.numberFormat || (xlsx_editing && dirty.valueRuns))
        ? cached_dirty_presentation(dirty, cell)
        : undefined;
    const requires_rich = !formula_edit
        && show_formatting && !diff_mode && xlsx_editing && dirty.valueRuns
        ? presentation?.requires_rich ?? dirty_requires_rich_text(dirty, cell)
        : false;
    return {
        dirty_value: dirty.value,
        ...(formula_edit && calculated_formula_result !== undefined
            ? { formula_result: calculated_formula_result }
            : {}),
        ...(formula_result_pending ? { formula_result_pending: true as const } : {}),
        ...(presentation?.display !== undefined ? { dirty_display: presentation.display } : {}),
        ...(requires_rich ? { dirty_rich: dirty.valueRuns } : {}),
        ...(diff_mode && !dirty.base_pending
            ? { diff_base: dirty.observedBase?.value ?? dirty.base }
            : {}),
    };
}

import { use_row_loader } from './use-row-loader';
import { theme_font_size_px, tint_from_color, use_vscode_theme } from './vscode-theme';

/** Alpha of the whole-row band behind added/deleted rows in git compare mode.
 *  Painted under cell text like the edit tints (see DIRTY_TINT_ALPHA), so
 *  legibility must not depend on the theme's own alpha choices. */
const COMPARE_BAND_ALPHA = 0.12;
/** Band fallbacks when the theme's git decoration foregrounds are unparseable
 *  (named colors) — conventional diff green/red at the band alpha. */
const COMPARE_ADDED_BG_FALLBACK = `rgba(76, 175, 80, ${COMPARE_BAND_ALPHA})`;
const COMPARE_DELETED_BG_FALLBACK = `rgba(229, 75, 75, ${COMPARE_BAND_ALPHA})`;

function pending_rendered_cell(
    cell: PendingRowCell | undefined,
    format: PendingRowFormat,
    source_column: number,
): RenderedCell | null {
    const number_format = format.kind === 'xlsx'
        ? format.cellNumberFormats?.[source_column] ?? undefined
        : undefined;
    const font_style = format.kind === 'xlsx'
        ? format.cellFontStyles?.[source_column]
        : undefined;
    if (cell === undefined && number_format === undefined && font_style === undefined) return null;
    const raw = cell?.value ?? '';
    const formula = format.kind === 'xlsx'
        && xlsx_edit_writes_formula(raw, cell?.valueRuns?.runs)
        ? raw
        : undefined;
    return {
        raw: formula === undefined ? raw : '',
        formatted: formula === undefined
            ? number_format === undefined
                ? raw
                : format_xlsx_edit_preview(raw, number_format)
            : UNKNOWN_XLSX_FORMULA_RESULT,
        ...(formula === undefined ? {} : { formula, formulaResultPending: true as const }),
        ...(cell?.valueRuns === undefined ? {} : { richText: cell.valueRuns }),
        ...(cell?.link == null ? {} : { hyperlink: cell.link }),
        ...(number_format === undefined ? {} : { numberFormat: number_format }),
        bold: font_style?.bold ?? false,
        italic: font_style?.italic ?? false,
        rawType: raw === '' ? 'empty' : 'string',
    };
}

import {
    host_bridge,
    pending_changes_durability,
} from './host-bridge';
import {
    create_pending_row_store,
    type PendingRowStoreChange,
    type PendingRowStore,
} from './pending-row-store';
import {
    pending_changes_after_move_discard,
    plan_pending_move_discard,
} from './pending-move-closure';
import {
    has_pending_structural_changes,
    MAX_PENDING_APPENDED_ROWS,
    type PendingAppendedRow,
    type PendingAppendBasis,
    type PendingFormulaReferenceBasis,
    type PendingRowCell,
    type PendingRowFormat,
    type PendingRowFormatTemplate,
    type PendingStructuralChanges,
    type PendingTailRemoval,
    type RowIdentity,
} from '../pending-changes';
import {
    create_pending_row_projection,
    type PendingRowProjection,
} from './pending-row-projection';
import { scroll_preview_to_row } from './preview-scroll';
import './glide-data-grid/styles.css';

function pending_topology_signature(
    changes: PendingStructuralChanges,
    tail_projection_key: string,
): string {
    return pending_topology_signature_for_rows(
        changes.appendedRows.map((row) => row.id),
        changes.tailRemovals,
        tail_projection_key,
    );
}

function pending_topology_signature_for_rows(
    appended_row_ids: readonly string[],
    tail_removals: readonly PendingTailRemoval[],
    tail_projection_key: string,
): string {
    return JSON.stringify([
        appended_row_ids,
        tail_removals.map((removal) => [
            removal.appendHistoryId,
            removal.sourceRow,
        ]),
        tail_projection_key,
    ]);
}

interface SelectionIdentityBounds {
    readonly start?: RowIdentity;
    readonly end?: RowIdentity;
    /** Raw host/source-display fallback when an endpoint is not resident. */
    readonly startSourceDisplayRow?: number;
    readonly endSourceDisplayRow?: number;
    /** Structural identities inside the interval, bounded by pending-row limits. */
    readonly interior: readonly RowIdentity[];
}

interface PreserveInteriorIdentity {
    readonly identity: RowIdentity;
    /** Raw display position before a newly resolved removal is compressed. */
    readonly oldDisplayRow?: number;
}

interface PendingTopologySelectionSnapshot {
    readonly selection: GridSelection;
    readonly rows: readonly SelectionIdentityBounds[];
    readonly current?: {
        readonly active?: RowIdentity;
        readonly activeSourceDisplayRow?: number;
        readonly column: number;
        readonly range: Rectangle & SelectionIdentityBounds;
        readonly rangeStack: readonly (Rectangle & SelectionIdentityBounds)[];
    };
}

interface DeferredPendingTopologySelection {
    readonly selection: GridSelection;
    readonly projection: PendingRowProjection;
    readonly topologyKey: string | null;
    readonly activeCandidateSourceRows: ReadonlySet<number>;
    readonly candidates: readonly PreserveInteriorIdentity[];
}

function projected_selection_row_identity(
    projection: PendingRowProjection,
    display_row: number,
): RowIdentity | undefined {
    return projection.row_at(display_row)?.identity;
}

function projected_selection_source_display_row(
    projection: PendingRowProjection,
    display_row: number,
): number | undefined {
    const row = projection.row_at(display_row);
    return row?.kind === 'source' ? row.sourceDisplayRow : undefined;
}

function preserved_selection_display_row(
    projection: PendingRowProjection,
    candidate: PreserveInteriorIdentity,
): number | undefined {
    return candidate.oldDisplayRow === undefined
        ? projection.display_row_for_identity(candidate.identity)
        : projection.display_row_for_source_display(candidate.oldDisplayRow)
            ?? projection.display_row_for_identity(candidate.identity);
}

function selection_identity_bounds(
    projection: PendingRowProjection,
    start: number,
    end: number,
    preserve_interior: readonly PreserveInteriorIdentity[] = [],
): SelectionIdentityBounds {
    let start_identity = projected_selection_row_identity(projection, start);
    let end_identity = projected_selection_row_identity(projection, end);
    const interior: RowIdentity[] = [];
    for (
        let row = Math.max(start, projection.deletedBandStart);
        row <= Math.min(end, projection.rowCount - 1);
        row += 1
    ) {
        const identity = projected_selection_row_identity(projection, row);
        if (identity !== undefined) interior.push(identity);
    }
    // A saved source row can enter the bounded deletion band only AFTER the
    // topology mutation. Capture just those incoming removal identities while
    // they still live in the old source band; scanning the whole selected source
    // interval would turn a million-row selection into a million-row update.
    for (const candidate of preserve_interior) {
        const { identity } = candidate;
        const old_display_row = preserved_selection_display_row(projection, candidate);
        if (old_display_row === start && start_identity === undefined) {
            start_identity = identity;
        } else if (old_display_row === end && end_identity === undefined) {
            end_identity = identity;
        } else if (old_display_row !== undefined
            && old_display_row > start
            && old_display_row < end) interior.push(identity);
    }
    const start_source_display_row = start_identity === undefined
        ? projected_selection_source_display_row(projection, start)
        : undefined;
    const end_source_display_row = end_identity === undefined
        ? projected_selection_source_display_row(projection, end)
        : undefined;
    return {
        start: start_identity,
        end: end_identity,
        ...(start_source_display_row === undefined
            ? {}
            : { startSourceDisplayRow: start_source_display_row }),
        ...(end_source_display_row === undefined
            ? {}
            : { endSourceDisplayRow: end_source_display_row }),
        interior,
    };
}

function capture_pending_topology_selection(
    selection: GridSelection,
    projection: PendingRowProjection,
    preserve_interior: readonly PreserveInteriorIdentity[] = [],
): PendingTopologySelectionSnapshot {
    const current = selection.current;
    const range_reader = (selection.rows as unknown as {
        toRanges?: () => readonly [number, number][];
        toArray?: () => number[];
    });
    const row_ranges = range_reader.toRanges?.() ?? (() => {
        const values = range_reader.toArray?.() ?? [];
        const ranges: [number, number][] = [];
        for (const value of values) {
            const last = ranges.at(-1);
            if (last !== undefined && last[1] === value) last[1] = value + 1;
            else ranges.push([value, value + 1]);
        }
        return ranges;
    })();
    const active_source_display_row = current === undefined
        ? undefined
        : projected_selection_source_display_row(projection, current.cell[1]);
    return {
        selection,
        rows: row_ranges.map(([start, end]) =>
            selection_identity_bounds(projection, start, end - 1, preserve_interior)),
        ...(current === undefined ? {} : {
            current: {
                active: projected_selection_row_identity(projection, current.cell[1])
                    ?? preserve_interior.find((candidate) =>
                        preserved_selection_display_row(projection, candidate)
                            === current.cell[1])?.identity,
                ...(active_source_display_row === undefined
                    ? {}
                    : { activeSourceDisplayRow: active_source_display_row }),
                column: current.cell[0],
                range: {
                    ...current.range,
                    ...selection_identity_bounds(
                        projection,
                        current.range.y,
                        current.range.y + current.range.height - 1,
                        preserve_interior,
                    ),
                },
                rangeStack: current.rangeStack.map((range) => ({
                    ...range,
                    ...selection_identity_bounds(
                        projection,
                        range.y,
                        range.y + range.height - 1,
                        preserve_interior,
                    ),
                })),
            },
        }),
    };
}

function remap_selection_bounds(
    bounds: SelectionIdentityBounds,
    projection: PendingRowProjection,
): readonly [number, number] | undefined {
    const endpoint_position = (
        identity: RowIdentity | undefined,
        source_display_row: number | undefined,
    ): number | undefined => identity === undefined
        ? source_display_row === undefined
            ? undefined
            : projection.display_row_for_source_display(source_display_row)
        : projection.display_row_for_identity(identity);
    const positions = [
        endpoint_position(bounds.start, bounds.startSourceDisplayRow),
        ...bounds.interior.map((identity) => projection.display_row_for_identity(identity)),
        endpoint_position(bounds.end, bounds.endSourceDisplayRow),
    ].filter((row): row is number => row !== undefined);
    if (positions.length === 0) return undefined;
    return [Math.min(...positions), Math.max(...positions)];
}

function remap_pending_topology_selection(
    snapshot: PendingTopologySelectionSnapshot,
    projection: PendingRowProjection,
): GridSelection {
    let rows = CompactSelection.empty();
    for (const bounds of snapshot.rows) {
        const mapped = remap_selection_bounds(bounds, projection);
        if (mapped !== undefined) rows = rows.add([mapped[0], mapped[1] + 1]);
    }
    const current = (() => {
        const captured = snapshot.current;
        if (captured === undefined) return undefined;
        const active_row = captured.active === undefined
            ? captured.activeSourceDisplayRow === undefined
                ? undefined
                : projection.display_row_for_source_display(
                    captured.activeSourceDisplayRow,
                )
            : projection.display_row_for_identity(captured.active);
        if (active_row === undefined) return undefined;
        const mapped_range = remap_selection_bounds(captured.range, projection);
        const range_rows = mapped_range === undefined
            ? [active_row, active_row] as const
            : [
                Math.min(mapped_range[0], active_row),
                Math.max(mapped_range[1], active_row),
            ] as const;
        const rangeStack = captured.rangeStack.flatMap((range) => {
            const mapped = remap_selection_bounds(range, projection);
            return mapped === undefined ? [] : [{
                x: range.x,
                y: mapped[0],
                width: range.width,
                height: mapped[1] - mapped[0] + 1,
            }];
        });
        return {
            cell: [captured.column, active_row] as Item,
            range: {
                x: captured.range.x,
                y: range_rows[0],
                width: captured.range.width,
                height: range_rows[1] - range_rows[0] + 1,
            },
            rangeStack,
        };
    })();
    return {
        columns: snapshot.selection.columns,
        rows,
        ...(current === undefined ? {} : { current }),
    };
}

function pending_snapshot_rows_by_id(
    rows: readonly PendingAppendedRow[],
): ReadonlyMap<string, { readonly row: PendingAppendedRow; readonly index: number }> {
    return new Map(rows.map((row, index) => [row.id, { row, index }]));
}

function pending_snapshot_removals_by_id(
    removals: readonly PendingTailRemoval[],
): ReadonlyMap<string, { readonly removal: PendingTailRemoval; readonly index: number }> {
    return new Map(removals.map((removal, index) => [
        removal.appendHistoryId,
        { removal, index },
    ]));
}

function pending_values_equal(left: unknown, right: unknown): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Build the row-owned history transition represented by two store snapshots. */
export function pending_row_history_changes(
    worksheet: WorksheetTarget,
    before: PendingStructuralChanges,
    after: PendingStructuralChanges,
    changed_rows?: readonly { readonly id: string; readonly index: number }[],
): HistoryChange[] {
    const templates = new Map([
        ...before.formatTemplates,
        ...after.formatTemplates,
    ].map((template) => [template.id, template]));
    const build_row_change = (
        pending_row_id: string,
        prior: { readonly row: PendingAppendedRow; readonly index: number } | undefined,
        next: { readonly row: PendingAppendedRow; readonly index: number } | undefined,
    ): HistoryChange | undefined => {
        if (
            prior?.index === next?.index
            && pending_values_equal(prior?.row ?? null, next?.row ?? null)
        ) return undefined;
        const used_template_ids = new Set([
            prior?.row.formatTemplateId,
            next?.row.formatTemplateId,
        ].filter((id): id is string => id !== undefined));
        return {
            kind: 'rowAppend',
            delta: {
                worksheet,
                pendingRowId: pending_row_id,
                before: prior?.row ?? null,
                after: next?.row ?? null,
                beforeIndex: prior?.index ?? null,
                afterIndex: next?.index ?? null,
                formatTemplates: [...used_template_ids].flatMap((id) => {
                    const template = templates.get(id);
                    return template === undefined ? [] : [template];
                }),
            },
        };
    };
    const hinted_rows = changed_rows !== undefined
        && before.appendedRows.length === after.appendedRows.length
        && changed_rows.every(({ id, index }) => before.appendedRows[index]?.id === id
            && after.appendedRows[index]?.id === id)
        ? changed_rows
        : undefined;
    let aligned = hinted_rows !== undefined
        || before.appendedRows.length === after.appendedRows.length;
    if (aligned && hinted_rows === undefined) {
        for (let index = 0; index < before.appendedRows.length; index += 1) {
            if (before.appendedRows[index].id !== after.appendedRows[index].id) {
                aligned = false;
                break;
            }
        }
    }
    const row_changes: HistoryChange[] = [];
    if (aligned) {
        const indices = hinted_rows?.map(({ index }) => index)
            ?? before.appendedRows.map((_, index) => index);
        for (const index of indices) {
            const prior = before.appendedRows[index];
            const next = after.appendedRows[index];
            if (prior === next) continue;
            const change = build_row_change(
                prior.id,
                { row: prior, index },
                { row: next, index },
            );
            if (change !== undefined) row_changes.push(change);
        }
    } else {
        const before_rows = pending_snapshot_rows_by_id(before.appendedRows);
        const after_rows = pending_snapshot_rows_by_id(after.appendedRows);
        const row_ids = new Set([...before_rows.keys(), ...after_rows.keys()]);
        for (const pending_row_id of row_ids) {
            const change = build_row_change(
                pending_row_id,
                before_rows.get(pending_row_id),
                after_rows.get(pending_row_id),
            );
            if (change !== undefined) row_changes.push(change);
        }
    }
    // Apply removals from the end and insertions from the beginning. That keeps
    // every recorded index stable while a multi-row gesture is replayed.
    row_changes.sort((left, right) => {
        if (left.kind !== 'rowAppend' || right.kind !== 'rowAppend') return 0;
        const left_removes = left.delta.after === null;
        const right_removes = right.delta.after === null;
        if (left_removes !== right_removes) return left_removes ? -1 : 1;
        return left_removes
            ? (right.delta.beforeIndex ?? -1) - (left.delta.beforeIndex ?? -1)
            : (left.delta.afterIndex ?? -1) - (right.delta.afterIndex ?? -1);
    });

    const before_removals = pending_snapshot_removals_by_id(before.tailRemovals);
    const after_removals = pending_snapshot_removals_by_id(after.tailRemovals);
    const removal_ids = before.tailRemovals === after.tailRemovals
        ? new Set<string>()
        : new Set([...before_removals.keys(), ...after_removals.keys()]);
    const removal_changes = [...removal_ids].map(
        (append_history_id): HistoryChange | undefined => {
            const prior = before_removals.get(append_history_id);
            const next = after_removals.get(append_history_id);
            if (
                prior?.index === next?.index
                && pending_values_equal(prior?.removal ?? null, next?.removal ?? null)
            ) return undefined;
            return {
                kind: 'tailRemoval',
                delta: {
                    worksheet,
                    appendHistoryId: append_history_id,
                    before: prior?.removal ?? null,
                    after: next?.removal ?? null,
                    beforeIndex: prior?.index ?? null,
                    afterIndex: next?.index ?? null,
                },
            };
        },
    ).filter((change): change is HistoryChange => change !== undefined);
    removal_changes.sort((left, right) => {
        if (left.kind !== 'tailRemoval' || right.kind !== 'tailRemoval') return 0;
        const left_removes = left.delta.after === null;
        const right_removes = right.delta.after === null;
        if (left_removes !== right_removes) return left_removes ? -1 : 1;
        return left_removes
            ? (right.delta.beforeIndex ?? -1) - (left.delta.beforeIndex ?? -1)
            : (left.delta.afterIndex ?? -1) - (right.delta.afterIndex ?? -1);
    });
    const metadata_change: HistoryChange[] = pending_values_equal(
        before.conflicts,
        after.conflicts,
    ) && pending_values_equal(
        before.appendBasis,
        after.appendBasis,
    ) ? [] : [{
        kind: 'pendingRows',
        delta: {
            worksheet,
            // Row/removal transitions run before this exact structural arm.
            // Put those dimensions on their post-gesture side in both snapshots,
            // so this delta owns only the append-basis and conflict transition.
            // Undo reverses the action and therefore restores the old authority
            // facts before restoring rows.
            before: {
                ...after,
                ...(before.appendBasis === undefined
                    ? { appendBasis: undefined }
                    : { appendBasis: before.appendBasis }),
                conflicts: before.conflicts,
            },
            after,
        },
    }];
    return [...row_changes, ...removal_changes, ...metadata_change];
}

/**
 * Editing snapshot reported up to {@link App} so it can drive the toolbar dirty
 * indicator, persist pending edits, and surface file-change information — all
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

/** Host-authorized structural rows. The renderer never invents row identities
 * or XLSX formatting dependencies locally. */
export interface AppendRowsAdmission {
    readonly rowIds: readonly string[];
    readonly formatTemplate: PendingRowFormatTemplate;
    readonly appendBasis: PendingAppendBasis;
    /** Settle the host reservation exactly once after local installation. */
    readonly settle: (accepted: boolean) => void;
}

/**
 * Imperative editing actions GridShell exposes to {@link App} (the toolbar
 * toggle and file-change notice live in App's layout, but the dirty map lives here
 * next to the loader). Populated into a ref App provides.
 */
export interface EditingHandle {
    /** Fold this sheet's live editor, then ask App to atomically save the workbook. */
    request_save(): boolean;
    /** Drop every dirty edit. */
    clear_dirty(): void;
    /** Legacy bulk action: drop edits whose underlying file-side cell changed. */
    discard_conflicted(): void;
    /**
     * Drop exactly the named source-keyed edits. Separate from
     * {@link discard_conflicted}, which uses renderer observations and is therefore
     * residency-gated. Keys the host names for a filtered-out row, evicted page, or
     * removed row use this explicit path instead.
    */
    discard_keys(keys: readonly string[]): void;
    /** Whether this mounted view can locate a source-keyed cell. */
    can_reveal_source_cell(source_row: number, source_column: number): boolean;
    /** Reveal and select a source-keyed cell, loading its row when its position is derivable. */
    reveal_source_cell(
        source_row: number,
        source_column: number,
        is_current?: () => boolean,
    ): Promise<boolean>;
    /** Reveal and select a pending row by its stable identity. */
    reveal_pending_row(pending_row_id: string): boolean;
    /** Remove conflicted pending rows as one undoable gesture. */
    remove_pending_rows(pending_row_ids: readonly string[]): boolean;
    /** Reveal an undo-only saved-row removal by stable append history identity. */
    reveal_tail_removal(append_history_id: string): boolean;
    /** Cancel conflicted saved-row removals as one undoable gesture. */
    cancel_tail_removals(append_history_ids: readonly string[]): boolean;
    /** Fence every renderer-side mutation before a host close/reload flush. */
    stop_edit_admission(): void;
    /** Snapshot the current Glide overlay into the source-keyed dirty map. */
    commit_live_edit(): boolean;
    /** Fold the overlay that was open when the close/reload fence was raised, once. */
    commit_live_edit_at_close_barrier(): boolean;
    /** Commit the overlay and synchronously publish this worksheet's complete map. */
    flush_live_edit(): boolean;
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
    /** Whether this mounted grid currently owns DOM focus. */
    has_focus(): boolean;
    /** Focus the mounted Glide grid; false while no DataEditor is available. */
    focus(): boolean;
    /** Pending-row identity under the active cell, captured before Save rekeys it. */
    pending_active_cell?(): {
        readonly pendingRowId: string;
        readonly sourceColumn: number;
    } | undefined;
}

export interface SavedRowFocus {
    readonly sequence: number;
    readonly sheetIndex: number;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly restoreFocus: boolean;
}

/** One-shot stable pending-row cursor restoration across a GridShell remount. */
export interface PendingRowFocus {
    readonly sequence: number;
    readonly sheetIndex: number;
    readonly pendingRowId: string;
    readonly sourceColumn: number;
    readonly restoreFocus: boolean;
}

/** Whether focus belongs to this grid, including Glide's body-level editor portal. */
function grid_owns_focus(root: HTMLElement | null, active: Element | null): boolean {
    if (!(active instanceof HTMLElement)) return false;
    if (root?.contains(active)) return true;
    const portal = document.getElementById('portal');
    const overlay = active.closest('.gdg-clip-region');
    return portal !== null && overlay !== null && portal.contains(overlay);
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

/** Local half of a host-backed gesture over source and pending rows. */
export interface PendingHostGesture {
    /** Commit the pending-row mutation and one combined history action. */
    commit(source_changes: readonly HistoryChange[], label: string): boolean;
    /** Abandon the still-staged pending-row mutation after a host refusal. */
    cancel(): void;
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
    /** Workbook-wide recursive pending-result projection for this worksheet. */
    pending_formula_impact?: FormulaSheetImpact;
    /** Raw calculation results keyed by canonical `row:column`. */
    formula_results?: ReadonlyMap<string, string>;
    /** Source-pending results retained beneath the current edit overlay. */
    source_formula_results?: ReadonlyMap<string, string>;
    /** Ordered unsaved cell moves, applied to formula source before display/edit. */
    formula_move_retargeter?: (
        formula: string,
        formulaSheetIndex: number,
        afterOrder?: number,
    ) => string;
    formula_reference_bases?: (
        value: string,
    ) => readonly PendingFormulaReferenceBasis[];
    generation: number;
    /** Source revision the pending structural overlay was derived from. */
    source_generation: number;
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
    /** The toolbar fit is installed for this sheet. Fitting changes widths,
     * but must not disable word wrapping for capped, unsampled, or edited text. */
    auto_fit_active?: boolean;
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
    on_row_resize: (
        rows: readonly DisplayRowInterval[],
        height: number,
        on_result?: (applied: boolean) => void,
    ) => void;
    merges: MergeRange[];
    preview_mode?: boolean;
    // Editing (Phase E). edit_mode is App-controlled (toolbar toggle); editing is
    // only possible when csv_editable.
    edit_mode?: boolean;
    /** Diff toolbar toggle: dirty cells paint before/after instead of just the
     *  new value. App-owned so it survives Edit off/on within the session. */
    diff_mode?: boolean;
    /** Git compare mode: host posts a compareDiff page beside every rowData
     *  window; changed cells paint before/after and added/deleted rows get a
     *  band tint. Read-only — App withdraws editing when this is on. */
    git_compare?: boolean;
    /** Compare-mode header diffs for this sheet: promoted column names live
     *  outside the row space, so a header-only edit never reaches the per-cell
     *  diff. Changed headers are annotated in the column title instead. */
    compare_changed_column_names?: readonly { col: number; base: string }[];
    /** Parent-owned identity of the committed edit-mode activation. */
    edit_activation_id: number;
    csv_editable?: boolean;
    /**
     * Whether a highlight gesture is awaiting the host's acknowledgement.
     *
     * Cells stop OFFERING an editor for that window, on the same reasoning as
     * `save_in_flight`: a highlight round-trips through durable state, and it is
     * recorded only when the host's deltas come back, so an edit recorded while
     * one is outstanding would enter the history BEFORE the highlight the user
     * made first — undo would then revert the highlight when the user expected
     * their typing back. The window is one host round trip, and the highlight
     * panel is already disabled across it.
     *
     * The affordance only. The barrier that actually keeps such an edit out of
     * the history is App's `gestures_admitted`, which every recorded gesture
     * passes through — including the hyperlink dialog, which reaches the store
     * without consulting any editability flag here.
     */
    highlight_in_flight?: boolean;
    /** A host-backed append reservation is outstanding; all edits are fenced. */
    append_in_flight?: boolean;
    /**
     * The source's effective append row ceiling — `append_row_ceiling_for` on
     * the host, delivered through the snapshot capability. Defaults to
     * `MAX_SHEET_ROWS`, the value every format shared before the ceiling
     * became a property of the profile; delimited sources pass Infinity.
     */
    append_row_ceiling?: number;
    /** How this sheet's cells are edited ('markdown' for xlsx). Default 'plain'. */
    edit_syntax?: EditSyntax;
    edit_session_id?: string;
    /** Workbook-wide durable order high-water mark, including inactive sheets. */
    value_edit_order_floor?: number;
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
    /** Session-owned structural rows; never folded into source-keyed edits. */
    pending_row_store?: PendingRowStore;
    /** Admit one atomic append gesture against the current source generation. */
    on_append_rows?: (count: number) => Promise<AppendRowsAdmission | undefined>;
    /**
     * The workbook's undo history. Hoisted like `edit_session`, and for a
     * stronger reason: history spans every sheet, so it cannot live in a shell
     * that is mounted per sheet and keyed by generation. A consumer without one
     * (the shell's own tests) edits exactly as before, unrecorded.
     */
    history_store?: HistoryStore;
    /**
     * Whether a new edit gesture may start. Absent means always.
     *
     * Carries the replay reservation down: while an undo is in flight, a keystroke
     * would be planned against a state the replay is about to move.
     */
    gestures_admitted?: () => boolean;
    /**
     * Source-keyed keys the host refused the last save over. Unioned into the
     * informational tint so a `baseMismatch` cell is visibly marked even when the
     * webview cannot inspect its non-resident row. A
     * `rowsRemoved` key has no cell to tint (its row is past `row_count`), which is
     * why the banner names its row numbers instead.
     */
    host_rejected_keys?: readonly string[];
    /** Current file sides returned by save-time validation for non-resident edits. */
    host_observed_bases?: Readonly<Record<string, CsvObservedFileBase>>;
    on_editing_change?: (status: EditingStatus) => void;
    // App provides this ref; GridShell populates it with imperative save/discard
    // actions so App's toolbar + file-change review can drive editing that lives here.
    editing_ref?: MutableRefObject<EditingHandle | null>;
    // App provides this ref; GridShell populates it with a function that measures
    // loaded rows and returns fitted column widths (null when nothing is loaded).
    auto_fit_ref?: MutableRefObject<(() => Record<number, number> | null) | null>;
    /** Notifies App when a deferred auto-fit may have become measurable. */
    on_auto_fit_sample_change?: () => void;
    /** App-owned bridge for restoring focus after generation-keyed remounts. */
    grid_focus_ref?: MutableRefObject<GridFocusHandle | null>;
    /** App-owned bridge for sheet-tab actions (select all / copy sheet). */
    grid_actions_ref?: MutableRefObject<GridActionsHandle | null>;
    /**
     * Where an undo or redo landed, retained by App across the sheet switch and
     * the generation-keyed remount a cross-sheet replay causes.
     *
     * Declarative rather than a method on `grid_actions_ref`: that handle carries
     * repeatable user actions, while this is a one-shot state transition with a
     * correlation that has to survive a remount to be delivered at all.
     */
    history_focus?: PendingHistoryFocus | null;
    /** Clears the App-owned request, reporting what the grid was able to do. */
    on_history_focus_applied?: (sequence: number, outcome: HistoryFocusOutcome) => void;
    /** One-shot source-keyed cursor restoration after a saved pending row is rekeyed. */
    saved_row_focus?: SavedRowFocus | null;
    on_saved_row_focus_applied?: (sequence: number, visible: boolean) => void;
    /** Stable pending-row cursor captured before a source-refresh remount. */
    pending_row_focus?: PendingRowFocus | null;
    on_pending_row_focus_applied?: (sequence: number, visible: boolean) => void;
    /**
     * This sheet's mapping generation, for checking a host-resolved focus against
     * the view actually installed. A projection resolved against a mapping that
     * has since moved names rows that are no longer the ones the replay touched.
     */
    mapping_generation?: number;
    /** Latest preview scroll request, retained by App across GridShell remounts. */
    pending_preview_scroll?: PendingPreviewScroll | null;
    /** Clears the App-owned request only after Glide accepts the scroll. */
    on_preview_scroll_applied?: (sequence: number) => void;
    /** Reports the latest user-visible preview row to App across remounts. */
    on_preview_visible_row_change?: (row: number) => void;
    /** Pixel offset captured by App before this generation-keyed mount. */
    initial_scroll_position?: ScrollPosition;
    /** Reports the worksheet's exact pixel offset so App can restore a remount. */
    on_scroll_position_change?: (position: ScrollPosition) => void;
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
        pending_gesture?: PendingHostGesture,
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
    pending_formula_impact,
    formula_results,
    source_formula_results,
    formula_move_retargeter,
    formula_reference_bases,
    generation,
    source_generation,
    row_count: source_row_count = sheet_meta.rowCount,
    show_formatting,
    auto_fit_active = false,
    column_projection,
    column_widths,
    on_column_resize,
    row_heights,
    row_height_overlay,
    on_row_resize,
    merges,
    preview_mode = false,
    edit_mode = false,
    diff_mode = false,
    git_compare = false,
    compare_changed_column_names,
    edit_activation_id,
    csv_editable = false,
    highlight_in_flight = false,
    append_in_flight = false,
    append_row_ceiling = MAX_SHEET_ROWS,
    edit_syntax = 'plain',
    edit_session_id,
    value_edit_order_floor = 0,
    save_operation,
    save_lifecycle = { revision: 0, state: 'idle' },
    on_save_request = () => undefined,
    initial_edits,
    edit_session,
    pending_row_store,
    on_append_rows,
    history_store,
    gestures_admitted,
    host_rejected_keys,
    host_observed_bases,
    on_editing_change,
    editing_ref,
    auto_fit_ref,
    on_auto_fit_sample_change,
    grid_focus_ref,
    grid_actions_ref,
    history_focus = null,
    on_history_focus_applied = () => {},
    saved_row_focus = null,
    on_saved_row_focus_applied = () => {},
    pending_row_focus = null,
    on_pending_row_focus_applied = () => {},
    mapping_generation = 1,
    pending_preview_scroll = null,
    on_preview_scroll_applied = () => {},
    on_preview_visible_row_change = () => {},
    initial_scroll_position,
    on_scroll_position_change = () => {},
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
        source_row_count,
        generation,
        has_visible_columns,
        sheet_meta.columnCount,
        sheet_meta.estimatedRowBytes,
    );
    const {
        theme,
        highContrast: high_contrast,
        dirtyBg: dirty_bg,
        conflictBg: conflict_bg,
        diffDeletedFg: diff_deleted_fg,
        diffAddedFg: diff_added_fg,
        diffMovedFg: diff_moved_fg,
    } = use_vscode_theme();
    // Stable object for build_grid_cell / the paint closure's dep array.
    const diff_colors = useMemo(
        () => ({ deleted: diff_deleted_fg, added: diff_added_fg }),
        [diff_deleted_fg, diff_added_fg],
    );
    // Band tints for whole added/deleted rows, derived from the same theme
    // foregrounds as the diff text so they track the active theme together.
    const compare_row_bgs = useMemo(
        () => ({
            added: tint_from_color(diff_added_fg, COMPARE_BAND_ALPHA, COMPARE_ADDED_BG_FALLBACK),
            deleted: tint_from_color(
                diff_deleted_fg, COMPARE_BAND_ALPHA, COMPARE_DELETED_BG_FALLBACK),
            // No separate literal fallback: diff_moved_fg is itself already a
            // resolved color rather than a theme variable that may be missing.
            moved: tint_from_color(diff_moved_fg, COMPARE_BAND_ALPHA, diff_moved_fg),
        }),
        [diff_added_fg, diff_deleted_fg, diff_moved_fg],
    );
    // The configured font size, resolved once from the theme so cell painting,
    // canvas measurement, and default row heights all agree.
    const font_size_px = theme_font_size_px(theme);
    const default_row_height = default_row_height_for_font(font_size_px);
    const grid_ref = useRef<DataEditorRef | null>(null);
    // Saving folds a link dialog through this handle before snapshotting the
    // workbook, just as it folds Glide's cell overlay through read_live_edit.
    const hyperlink_dialog_ref = useRef<HyperlinkDialogHandle | null>(null);
    const hyperlink_dialog_pin_ref = useRef<symbol | null>(null);
    const hyperlink_focus_restore_epoch_ref = useRef(0);
    const grid_root_ref = useRef<HTMLDivElement | null>(null);
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
        return grid_owns_focus(grid_root_ref.current, document.activeElement);
    }, []);

    // Controlled selection. We intercept every change to snap it onto whole
    // merges (a click/drag landing on a covered cell selects the merge block);
    // native Ctrl+C then copies the rectangle via `getCellsForSelection`.
    const [grid_selection, set_grid_selection] = useState<GridSelection>({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
    });
    const grid_selection_ref = useRef(grid_selection);
    grid_selection_ref.current = grid_selection;
    const pending_projection_ref = useRef<PendingRowProjection>(null!);
    const committed_pending_projection_ref = useRef<PendingRowProjection | null>(null);
    const committed_pending_projection_key_ref = useRef<string | null>(null);
    const pending_topology_selection_ref = useRef<PendingTopologySelectionSnapshot | null>(null);
    const deferred_pending_topology_selection_ref =
        useRef<DeferredPendingTopologySelection | null>(null);

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
        row_number: number;
        selected_row_count: number;
        /** Raw host display intervals, captured before structural compression. */
        source_display_rows: DisplayRowInterval[];
        /** Stable structural identities captured when the menu opened. */
        pending_row_ids: string[];
        tail_removal_source_rows: number[];
    }) | null>(null);

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
    // The vendored grid owns merge behavior (rendering, selection snapping,
    // navigation, copy blanking) from this one prop, in display coordinates.
    // App withholds merges (`merges={[]}`) whenever a transform or hidden
    // column makes display differ from source, so source coordinates *are*
    // display coordinates here — mapped 1:1, not projected. A partial
    // projection would be worse than none: it could map an anchor column
    // while leaving the width in source space.
    const merged_ranges = useMemo<Rectangle[]>(() => merges.map((m) => ({
        x: m.startCol,
        y: m.startRow,
        width: m.endCol - m.startCol + 1,
        height: m.endRow - m.startRow + 1,
    })), [merges]);
    // Only multi-row merges can have an anchor row above the viewport; filter
    // once so the per-scroll preload scan walks just these, not the (capped at
    // 10k) full list.
    const vertical_merged_ranges = useMemo(
        () => merged_ranges.filter((m) => m.height > 1),
        [merged_ranges],
    );
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
        trim_rows,
        pin_rows,
        unpin_rows,
        get_row,
        get_source_row,
        get_cell_raw_for_source,
        get_cell_for_source,
        get_display_row_for_source,
        get_compare_status,
        get_compare_base,
        sample_loaded_rows,
        version,
    } = loader;
    const lifecycle_operation = save_lifecycle.state === 'active'
        && save_lifecycle.operation.editSessionId === edit_session_id
        ? save_lifecycle.operation
        : undefined;
    const restored_save_operation = save_operation?.editSessionId === edit_session_id
        ? save_operation
        : lifecycle_operation;
    const worksheet_payload = useCallback((operation: CsvSaveOperation | undefined) =>
        operation && save_operation_worksheet(
            operation,
            sheet_index,
            sheet_meta.name,
            sheet_meta.worksheetId,
        ), [sheet_index, sheet_meta.name, sheet_meta.worksheetId]);
    const restored_worksheet = useMemo(
        () => worksheet_payload(restored_save_operation),
        [restored_save_operation, worksheet_payload],
    );
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
    const fallback_pending_store_ref = useRef<PendingRowStore | null>(null);
    if (pending_row_store === undefined && fallback_pending_store_ref.current === null) {
        fallback_pending_store_ref.current = create_pending_row_store({
            session_id: edit_session_id,
        });
    }
    const pending_store = pending_row_store ?? fallback_pending_store_ref.current!;
    const pending_store_changes_ref = useRef<PendingRowStoreChange>({ kind: 'reset' });
    const pending_topology_revision_ref = useRef(0);
    const pending_payload_revision_ref = useRef(0);
    const subscribe_pending_store = useCallback((listener: () => void) =>
        pending_store.subscribe((change) => {
            if (change.kind === 'reset' && pending_projection_ref.current !== null) {
                // Store listeners run synchronously after the mutation and before
                // React replaces the rendered snapshot. Capture the selection
                // against the old projection here, while its pending-row accessor
                // still reads the prior `pending_rows_ref` value.
                const projection = pending_projection_ref.current;
                const selection = grid_selection_ref.current;
                const candidates = pending_store.snapshot().tailRemovals.map((removal) => ({
                    identity: {
                        kind: 'source' as const,
                        sourceRow: removal.sourceRow,
                    },
                }));
                pending_topology_selection_ref.current =
                    capture_pending_topology_selection(selection, projection, candidates);
                const prior_deferred = deferred_pending_topology_selection_ref.current;
                const candidate_source_rows = new Set(candidates.flatMap((candidate) =>
                    candidate.identity.kind === 'source'
                        ? [candidate.identity.sourceRow]
                        : []));
                const has_unresolved_candidate = candidates.some((candidate) =>
                    projection.display_row_for_identity(candidate.identity) === undefined);
                const merged_candidates = prior_deferred === null
                    ? candidates
                    : [...new Map([
                        ...prior_deferred.candidates,
                        ...candidates,
                    ].map((candidate) => [
                        candidate.identity.kind === 'source'
                            ? `source:${candidate.identity.sourceRow}`
                            : `pending:${candidate.identity.pendingRowId}`,
                        candidate,
                    ])).values()];
                deferred_pending_topology_selection_ref.current = prior_deferred !== null
                    ? {
                        ...prior_deferred,
                        activeCandidateSourceRows: candidate_source_rows,
                        candidates: merged_candidates,
                    }
                    : has_unresolved_candidate
                        ? {
                            selection,
                            projection,
                            topologyKey: committed_pending_projection_key_ref.current,
                            activeCandidateSourceRows: candidate_source_rows,
                            candidates,
                        }
                        : null;
            }
            const accumulated = pending_store_changes_ref.current;
            if (change.kind === 'reset' || accumulated.kind === 'reset') {
                pending_store_changes_ref.current = { kind: 'reset' };
                pending_topology_revision_ref.current += 1;
            } else {
                const rows = new Map(accumulated.rows.map((row) => [row.id, row]));
                for (const row of change.rows) rows.set(row.id, row);
                pending_store_changes_ref.current = { kind: 'rows', rows: [...rows.values()] };
            }
            pending_payload_revision_ref.current += 1;
            listener();
        }), [pending_store]);
    const pending_rows = useSyncExternalStore(
        subscribe_pending_store,
        pending_store.snapshot,
        pending_store.snapshot,
    );
    const pending_rows_ref = useRef(pending_rows);
    pending_rows_ref.current = pending_rows;
    const pending_payload_revision = pending_payload_revision_ref.current;
    const source_display_request_sequence_ref = useRef(0);
    const [resolved_source_display_rows, set_resolved_source_display_rows] = useState<{
        readonly generation: number;
        readonly mappingGeneration: number;
        readonly rows: ReadonlyMap<number, number | null>;
    }>({ generation: -1, mappingGeneration: -1, rows: new Map() });
    const source_display_query_rows = useMemo(() => [...new Set([
        ...pending_rows.tailRemovals.map((removal) => removal.sourceRow),
        ...(deferred_pending_topology_selection_ref.current?.candidates.flatMap(
            (candidate) => candidate.identity.kind === 'source'
                ? [candidate.identity.sourceRow]
                : [],
        ) ?? []),
        ...(saved_row_focus !== null
            && saved_row_focus.sheetIndex === sheet_index
            && saved_row_focus.sourceRow < sheet_meta.sourceRowCount
            ? [saved_row_focus.sourceRow]
            : []),
    ])].sort((left, right) => left - right), [
        pending_rows.tailRemovals,
        saved_row_focus,
        sheet_index,
        sheet_meta.sourceRowCount,
    ]);
    useEffect(() => {
        const queried_source_rows = new Set(source_display_query_rows);
        set_resolved_source_display_rows((current) => ({
            generation,
            mappingGeneration: mapping_generation,
            rows: current.generation === generation
                && current.mappingGeneration === mapping_generation
                ? new Map([...current.rows].filter(([source_row]) =>
                    queried_source_rows.has(source_row)))
                : new Map(),
        }));
        if (source_display_query_rows.length === 0 || transform_pending) return;
        const request_id = [
            'source-display-rows',
            sheet_index,
            ++source_display_request_sequence_ref.current,
        ].join(':');
        const handler = (event: MessageEvent) => {
            const message = event.data as HostMessage;
            if (
                message?.type !== 'sourceDisplayRows'
                || message.requestId !== request_id
                || message.sheetIndex !== sheet_index
                || message.generation !== generation
                || message.mappingGeneration !== mapping_generation
                || message.sourceRows.length !== message.displayRows.length
            ) return;
            set_resolved_source_display_rows({
                generation,
                mappingGeneration: mapping_generation,
                rows: new Map(message.sourceRows.map(
                    (source_row, index) => [source_row, message.displayRows[index]],
                )),
            });
        };
        window.addEventListener('message', handler);
        host_bridge.postMessage({
            type: 'requestSourceDisplayRows',
            requestId: request_id,
            sheetIndex: sheet_index,
            sourceRows: source_display_query_rows,
            generation,
        });
        return () => window.removeEventListener('message', handler);
    }, [
        generation,
        mapping_generation,
        sheet_index,
        source_display_query_rows,
        transform_pending,
    ]);
    const authoritative_display_row_for_source = useCallback((source_row: number) => {
        const resident = get_display_row_for_source(source_row);
        if (resident !== undefined) return resident;
        if (
            resolved_source_display_rows.generation !== generation
            || resolved_source_display_rows.mappingGeneration !== mapping_generation
        ) return undefined;
        const resolved = resolved_source_display_rows.rows.get(source_row);
        return resolved === null ? undefined : resolved;
    }, [
        generation,
        get_display_row_for_source,
        mapping_generation,
        resolved_source_display_rows,
    ]);
    const projected_source_rows = transform_state.sort.length > 0
        || transform_state.filters.length > 0
        || (transform_state.hiddenRows?.length ?? 0) > 0
        || transform_state.onlyChangedRows === true;
    const removed_source_display_rows = useMemo(() => {
        const header = sheet_meta.excelFirstRowHeader;
        return pending_rows.tailRemovals.flatMap((removal) => {
            const loaded = authoritative_display_row_for_source(removal.sourceRow);
            if (loaded !== undefined) return [loaded];
            if (projected_source_rows) return [];
            if (header?.active === true) {
                const promoted = header.sourceRow ?? 0;
                if (removal.sourceRow === promoted) return [];
                return [removal.sourceRow < promoted
                    ? removal.sourceRow
                    : removal.sourceRow - 1];
            }
            return [removal.sourceRow];
        });
    }, [
        authoritative_display_row_for_source,
        pending_rows.tailRemovals,
        sheet_meta.excelFirstRowHeader,
        projected_source_rows,
        version,
    ]);
    const projected_tail_removal_ids = useMemo(() => projected_source_rows
        ? new Set(pending_rows.tailRemovals.flatMap((removal) =>
            authoritative_display_row_for_source(removal.sourceRow) !== undefined
            || resolved_source_display_rows.generation === generation
                && resolved_source_display_rows.mappingGeneration === mapping_generation
                && resolved_source_display_rows.rows.has(removal.sourceRow)
                ? [removal.appendHistoryId]
                : []))
        : undefined, [
        authoritative_display_row_for_source,
        generation,
        mapping_generation,
        pending_rows.tailRemovals,
        projected_source_rows,
        resolved_source_display_rows,
    ]);
    // Clipboard reads and row admission are asynchronous. A transformed suffix
    // removal can finish its inverse lookup during either await and turn an
    // appended row into a replacement, changing the row topology without a new
    // transform generation. DataEditor uses this signature to roll back its own
    // admitted rows before applying a paste against stale numeric coordinates.
    const tail_removal_projection_key = projected_tail_removal_ids === undefined
        ? 'natural'
        : JSON.stringify(pending_rows.tailRemovals.flatMap((removal) =>
            projected_tail_removal_ids.has(removal.appendHistoryId)
                ? [removal.appendHistoryId]
                : []));
    const pending_topology_key = pending_topology_signature(
        pending_rows,
        tail_removal_projection_key,
    );
    const paste_topology_key = [
        mapping_generation,
        column_projection.visible_to_source.join(','),
        pending_topology_key,
    ].join(':');
    const pending_selection_topology_key = [
        mapping_generation,
        pending_topology_key,
    ].join(':');
    const paste_topology_key_ref = useRef(paste_topology_key);
    paste_topology_key_ref.current = paste_topology_key;
    const pending_tail_removal_source_rows = useMemo(() => new Set(
        pending_rows.tailRemovals.map((removal) => removal.sourceRow),
    ), [pending_rows.tailRemovals]);
    const pending_projection = useMemo(() => create_pending_row_projection({
        sourceDisplayRowCount: source_row_count,
        sourceRowAt: get_source_row,
        displayRowForSource: authoritative_display_row_for_source,
        sourceRowCount: sheet_meta.sourceRowCount,
        changes: pending_rows,
        appendedRowAt: (index) => pending_rows_ref.current.appendedRows[index],
        removedSourceDisplayRows: removed_source_display_rows,
        projectedTailRemovalIds: projected_tail_removal_ids,
    }), [
        authoritative_display_row_for_source,
        get_source_row,
        pending_store,
        pending_topology_revision_ref.current,
        removed_source_display_rows,
        projected_tail_removal_ids,
        sheet_meta.sourceRowCount,
        source_row_count,
        version,
    ]);
    const row_count = pending_projection.rowCount;
    pending_projection_ref.current = pending_projection;
    const source_row_for_projected_display = useCallback((display_row: number) => {
        const projected = pending_projection.row_at(display_row);
        return projected?.kind === 'source'
            ? get_source_row(projected.sourceDisplayRow)
            : undefined;
    }, [get_source_row, pending_projection]);
    const pending_display_row_by_physical = useMemo(() => {
        const rows = new Map<number, number>();
        for (
            let display_row = pending_projection.pendingBandStart;
            display_row < pending_projection.rowCount;
            display_row += 1
        ) {
            const projected = pending_projection.row_at(display_row);
            if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
                rows.set(projected.intendedPhysicalRow, display_row);
            }
        }
        return rows;
    }, [pending_projection]);
    const pending_template_formats = useMemo(() => new Map(
        pending_rows.formatTemplates.map((template) => [template.id, template.format]),
    ), [pending_rows.formatTemplates]);
    const pending_render_cache_ref = useRef<{
        readonly store: PendingRowStore;
        readonly rows: Map<string, (RenderedCell | null)[]>;
    }>();
    const pending_rendered_rows = useMemo(() => {
        const change = pending_store_changes_ref.current;
        pending_store_changes_ref.current = { kind: 'rows', rows: [] };
        let cache = pending_render_cache_ref.current;
        if (cache === undefined || cache.store !== pending_store || change.kind === 'reset') {
            cache = { store: pending_store, rows: new Map() };
            pending_render_cache_ref.current = cache;
        }
        const changed_rows = change.kind === 'reset' ? pending_rows.appendedRows : change.rows;
        for (const row of changed_rows) {
            const format = pending_template_formats.get(row.formatTemplateId);
            if (format === undefined) {
                cache.rows.delete(row.id);
                continue;
            }
            const rendered: (RenderedCell | null)[] = [];
            for (const [column_text, cell] of Object.entries(row.cells)) {
                const column = Number(column_text);
                rendered[column] = pending_rendered_cell(cell, format, column);
            }
            cache.rows.set(row.id, rendered);
        }
        return cache.rows;
    }, [
        pending_payload_revision,
        pending_rows,
        pending_store,
        pending_template_formats,
    ]);
    const removal_rendered_rows = useMemo(() => {
        const rows = new Map<number, (RenderedCell | null)[]>();
        for (const removal of pending_rows.tailRemovals) {
            const rendered: (RenderedCell | null)[] = [];
            for (const [column_text, cell] of Object.entries(removal.savedRow.cells)) {
                const column = Number(column_text);
                rendered[column] = pending_rendered_cell(
                    cell,
                    removal.savedRow.format,
                    column,
                );
            }
            rows.set(removal.sourceRow, rendered);
        }
        return rows;
    }, [pending_rows.tailRemovals]);
    // Full identity, all three fields, on every recorded change: a workbook-wide
    // undo has to find its way back to the sheet an edit was made on, and a bare
    // index cannot survive a reorder between the edit and the undo.
    const history_capture = useMemo((): HistoryCaptureOptions | undefined => (
        history_store === undefined ? undefined : {
            worksheet: {
                sheetIndex: sheet_index,
                ...(sheet_meta.name === undefined ? {} : { sheetName: sheet_meta.name }),
                ...(sheet_meta.worksheetId === undefined
                    ? {}
                    : { worksheetId: sheet_meta.worksheetId }),
            },
            history: history_store,
        }
    ), [history_store, sheet_index, sheet_meta.name, sheet_meta.worksheetId]);
    const envelope_refusal_sequence_ref = useRef(0);
    const show_pending_size_warning = useCallback(() => {
        host_bridge.postMessage({
            type: 'showWarning',
            message: 'The edit is too large to keep as pending changes.',
        });
    }, []);
    const record_pending_row_gesture = useCallback((
        label: string,
        before: PendingStructuralChanges,
        after: PendingStructuralChanges,
    ): void => {
        if (history_capture === undefined) return;
        const changes = pending_row_history_changes(
            history_capture.worksheet,
            before,
            after,
        );
        if (changes.length === 0) return;
        const record = history_capture.history.stage_record({ label, changes });
        commit_staged_transaction([record]);
    }, [history_capture]);
    const apply_row_resize = useCallback((
        intervals: readonly DisplayRowInterval[],
        height: number,
        _record_history = true,
    ) => {
        if (gestures_admitted !== undefined && !gestures_admitted()) return;
        const projection = pending_projection_ref.current;
        const compressed_source_intervals: DisplayRowInterval[] = [];
        const pending_ids = new Set<string>();
        for (const interval of intervals) {
            const source_end = Math.min(
                interval.end,
                projection.deletedBandStart - 1,
            );
            if (source_end >= interval.start) {
                compressed_source_intervals.push({ start: interval.start, end: source_end });
            }
            for (
                let row = Math.max(interval.start, projection.deletedBandStart);
                row <= interval.end;
                row += 1
            ) {
                const projected = projection.row_at(row);
                if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
                    pending_ids.add(projected.row.id);
                }
            }
        }
        const source_intervals = projection.source_display_intervals(
            compressed_source_intervals,
        );
        if (pending_ids.size === 0) {
            if (source_intervals.length > 0) on_row_resize(source_intervals, height);
            return;
        }
        const before = pending_store.snapshot();
        const after: PendingStructuralChanges = {
            ...before,
            appendedRows: before.appendedRows.map((row) => pending_ids.has(row.id)
                ? { ...row, viewerRowHeight: height }
                : row),
        };
        // Stage first. This is both envelope preflight and the compare-and-swap
        // reservation that keeps a mixed source/pending resize all-or-nothing.
        const refusal_before = envelope_refusal_sequence_ref.current;
        const pending_stage = pending_store.stage_replace(edit_session_id, before, after);
        if (pending_stage === undefined) {
            if (envelope_refusal_sequence_ref.current !== refusal_before) {
                show_pending_size_warning();
            }
            return;
        }
        const finish = (applied: boolean): void => {
            if (!applied || !pending_stage.valid()) return;
            pending_stage.commit();
            pending_stage.notify();
        };
        if (source_intervals.length > 0) {
            on_row_resize(source_intervals, height, finish);
        } else {
            finish(true);
        }
    }, [
        edit_session_id,
        gestures_admitted,
        on_row_resize,
        pending_store,
        show_pending_size_warning,
    ]);
    const row_marker_options = useMemo(() => {
        const physical_row_count = Math.max(
            sheet_meta.sourceRowCount,
            sheet_meta.sourceRowCount
                - pending_rows.tailRemovals.length
                + pending_rows.appendedRows.length,
        );
        const promoted_source_row = sheet_meta.excelFirstRowHeader?.active
            ? sheet_meta.excelFirstRowHeader?.sourceRow ?? 0
            : undefined;
        const mapping_changes_rows = transform_state.sort.length > 0
            || transform_state.filters.length > 0
            || (transform_state.hiddenRows?.length ?? 0) > 0
            || transform_state.onlyChangedRows === true;
        const width = physical_row_count > 10_000
            ? 48
            : physical_row_count > 1_000
                ? 44
                : physical_row_count > 100 ? 36 : 32;
        return {
            kind: 'clickable-number' as const,
            width,
            getRowNumber: (display_row: number) => {
                const projected = pending_projection.row_at(display_row);
                if (projected?.kind === 'pending'
                    || projected?.kind === 'replacement'
                    || projected?.kind === 'removal') {
                    return projected.intendedPhysicalRow + 1;
                }
                const source_row = projected?.kind === 'source'
                    ? projected.identity?.sourceRow
                    : undefined;
                if (source_row !== undefined) return source_row + 1;
                if (mapping_changes_rows) return undefined;
                const projected_source_row = promoted_source_row !== undefined
                    && display_row >= promoted_source_row
                    ? display_row + 1
                    : display_row;
                return projected_source_row + 1;
            },
        };
    }, [
        pending_projection,
        pending_rows.appendedRows.length,
        pending_rows.tailRemovals.length,
        sheet_meta.excelFirstRowHeader,
        sheet_meta.sourceRowCount,
        transform_state.filters.length,
        transform_state.hiddenRows?.length,
        transform_state.onlyChangedRows,
        transform_state.sort.length,
    ]);
    // Values posted in the in-flight save; edit bases use these before reload.
    const saved_edits_ref = useRef<Record<string, string>>(
        restored_worksheet ? { ...restored_worksheet.edits } : {},
    );
    const save_operation_ref = useRef<CsvSaveOperation | undefined>(
        restored_save_operation,
    );
    const save_in_flight_ref = useRef(restored_save_operation !== undefined);
    // A fence belongs to one committed EDIT-ADMISSION activation, not merely one
    // host session. App owns this identity because only the parent sees committed
    // grants and session replacement. Deriving it here by mutating refs during
    // render leaked transitions from abandoned concurrent renders into the mounted
    // tree, reopening mutation paths before React committed the new activation.
    //
    // The ref closes mutation paths synchronously before App crosses an async host
    // boundary. State only requests the render that closes Glide's declarative
    // affordances (`allowOverlay`, paste, fill handle); both name the same parent
    // activation, so there is no independent boolean to forget to reset.
    const fenced_edit_activation_ref = useRef<number | null>(null);
    const [fenced_edit_activation, set_fenced_edit_activation] =
        useState<number | null>(null);
    const edit_admission_is_fenced = useCallback(
        () => fenced_edit_activation_ref.current === edit_activation_id,
        [edit_activation_id],
    );
    const close_barrier_active = fenced_edit_activation === edit_activation_id;
    // A close/reload barrier gets one privileged fold of the overlay that was
    // already open when the fence rose. Repeated flush requests in the same
    // activation must not turn that exception into a general mutation path.
    const close_barrier_folded_activation_ref = useRef<number | null>(null);

    // Read a cell's persisted raw text from the paged cache for the editing hook.
    // Stabilized against the loader's per-render callback identities; `version` in
    // the deps makes file-change observation re-run as freshly-loaded pages arrive.
    // `get_row_ref` is still the copy path's reader (display-keyed, by design).
    const get_row_ref = useRef(get_row);
    get_row_ref.current = get_row;
    const get_cell_raw_for_source_ref = useRef(get_cell_raw_for_source);
    get_cell_raw_for_source_ref.current = get_cell_raw_for_source;
    const get_cell_for_source_ref = useRef(get_cell_for_source);
    get_cell_for_source_ref.current = get_cell_for_source;
    // First parameter is a **canonical source row**, not a display row: durable
    // edit keys are source-keyed, and the store hands the row component of a key
    // straight to this reader (file-change observation / resolve_pending_bases).
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
            // A formula's editable persisted value is its source, not the
            // numeric cache rendered in the grid. Dirty entries record that
            // source as their base, so conflict checks must read the same side
            // or every untouched formula looks externally modified.
            const cell = get_cell_for_source_ref.current(source_row, c);
            if (cell?.formula !== undefined) return cell.formula;
            // Source row not resident (evicted, not yet fetched, or filtered out of
            // the current view): undefined so conflict detection treats it as
            // unknown, never as a changed value.
            return get_cell_raw_for_source_ref.current(source_row, c);
        },
        [version],
    );

    const issue_value_edit_order = useCallback(
        () => next_value_edit_order(Math.max(
            value_edit_order_floor,
            latest_dirty_value_edit_order(store.snapshot()),
        )),
        [store, value_edit_order_floor],
    );

    const {
        dirty_cells,
        conflicted_keys: derived_conflicted_keys,
        commit_edit,
        commit_edits,
        commit_edits_result,
        can_capture_edits,
        clear_dirty,
        replace_dirty,
        clear_dirty_keys,
        discard_conflicted,
        commit_hyperlinks,
    } = use_editing(get_cell_raw, generation, edit_session_id, store, {
        syntax: edit_syntax,
        capture: history_capture,
        gestures_admitted,
        formula_edit_text: (source_row, source_column, text, after_order) => {
            const entry = store.snapshot().get(`${source_row}:${source_column}`);
            const writes_formula = entry === undefined
                ? get_cell_for_source_ref.current(source_row, source_column)?.formula !== undefined
                : xlsx_edit_writes_formula(entry.value, entry.valueRuns?.runs);
            return writes_formula
                ? formula_move_retargeter?.(text, sheet_index, after_order) ?? text
                : text;
        },
        formula_reference_bases,
        next_value_edit_order: issue_value_edit_order,
        // Same identity discipline as get_cell_raw: rebinds with `version` so
        // freshly-loaded pages refresh markdown edit text and bases.
        get_cell: useCallback(
            (source_row: number, col: number) =>
                get_cell_for_source_ref.current(source_row, col),
            [version],
        ),
    });
    const cut_validation_key = useMemo(() => Object.freeze({
        sourceCells: dirty_cells,
        pendingPayloadRevision: pending_payload_revision,
    }), [dirty_cells, pending_payload_revision]);
    const pending_cells_envelope_ref = useRef<{
        readonly snapshot: ReadonlyMap<string, DirtyEntry>;
        readonly cells: CsvDirtyMap;
        readonly encodedBytes: number;
    }>();
    useLayoutEffect(() => {
        const worksheet = {
            sheetIndex: sheet_index,
            sheetName: sheet_meta.name,
            ...(sheet_meta.worksheetId === undefined
                ? {}
                : { worksheetId: sheet_meta.worksheetId }),
        };
        const clear_pending = pending_store.set_envelope_context(
            worksheet,
            () => {
                const snapshot = store.snapshot();
                let cached = pending_cells_envelope_ref.current;
                if (cached === undefined || cached.snapshot !== snapshot) {
                    const cells = Object.fromEntries(snapshot);
                    cached = {
                        snapshot,
                        cells,
                        encodedBytes: new TextEncoder().encode(JSON.stringify(cells)).byteLength,
                    };
                    pending_cells_envelope_ref.current = cached;
                }
                return cached;
            },
            () => { envelope_refusal_sequence_ref.current += 1; },
        );
        const clear_cells = store.set_write_validator(
            (entries) => pending_store.envelope_fits(Object.fromEntries(entries)),
            () => { envelope_refusal_sequence_ref.current += 1; },
        );
        return () => {
            clear_cells();
            clear_pending();
        };
    }, [
        pending_store,
        sheet_index,
        sheet_meta.name,
        sheet_meta.worksheetId,
        store,
    ]);
    const header_source_row = sheet_meta.excelFirstRowHeader?.sourceRow ?? 0;
    const effective_column_names = useMemo(() => sheet_meta.columnNames?.map(
        (name, column) => {
            if (sheet_meta.excelFirstRowHeader?.active !== true) return name;
            const dirty = dirty_cells.get(`${header_source_row}:${column}`);
            return dirty === undefined ? name : committed_column_name(dirty.value);
        },
    ), [
        dirty_cells,
        header_source_row,
        sheet_meta.columnNames,
        sheet_meta.excelFirstRowHeader?.active,
    ]);
    const columns = useMemo<GridColumn[]>(
        () => {
            const built = build_grid_columns(
                visible_source_columns,
                column_widths,
                effective_column_names,
            );
            if (!compare_changed_column_names?.length) return built;
            const base_by_col = new Map(compare_changed_column_names
                .map(({ col, base }) => [col, base]));
            return built.map((column, display_index) => {
                const source_column = visible_source_columns[display_index];
                const base = source_column === undefined
                    ? undefined
                    : base_by_col.get(source_column);
                return base === undefined
                    ? column
                    : { ...column, title: `${column.title} (was: ${base || 'blank'})` };
            });
        },
        [
            visible_source_columns,
            column_widths,
            effective_column_names,
            compare_changed_column_names,
        ],
    );
    const [rename_column, set_rename_column] = useState<{
        sourceColumn: number;
        initial: string;
    } | null>(null);
    const apply_column_rename = useCallback((value: string): boolean => {
        if (!rename_column) return false;
        const source_column = rename_column.sourceColumn;
        return commit_edits([{
            source_row: header_source_row,
            source_col: source_column,
            value,
            openedValue: rename_column.initial,
            persistedCell: {
                raw: sheet_meta.columnHeaderEditTexts?.[source_column]
                    ?? rename_column.initial,
                bold: false,
                italic: false,
            },
        }], 'Rename column');
    }, [commit_edits, header_source_row, rename_column, sheet_meta]);
    useEffect(() => {
        if (!host_observed_bases) return;
        store.observe_file_bases(
            edit_session_id,
            new Map(Object.entries(host_observed_bases)),
        );
    }, [edit_session_id, host_observed_bases, store]);
    // The paint callback deliberately stays stable across edits. It reads the
    // current recursive invalidation set through this mirror, while the repaint
    // effect below damages only formulas entering or leaving the set.
    const pending_formula_impact_ref = useRef(pending_formula_impact);
    pending_formula_impact_ref.current = pending_formula_impact;
    const formula_results_ref = useRef(formula_results);
    formula_results_ref.current = formula_results;
    const source_formula_results_ref = useRef(source_formula_results);
    source_formula_results_ref.current = source_formula_results;
    const calculated_formula_result_for_cell = useCallback((
        source_row: number,
        source_column: number,
        key: string,
        cell: RenderedCell | null | undefined,
        known_affected?: boolean,
    ): string | undefined => {
        const affected = known_affected ?? pending_formula_impact_ref.current
            ?.has(source_row, source_column) === true;
        const raw_result = formula_results_ref.current?.get(key)
            ?? (affected ? undefined : source_formula_results_ref.current?.get(key));
        return calculated_formula_display(raw_result, show_formatting, cell);
    }, [show_formatting]);
    const value_overlay_for_cell = useCallback((
        source_row: number,
        source_column: number,
        key: string,
        cell: RenderedCell | null | undefined,
        dirty: DirtyEntry | undefined,
    ): Pick<
        CellEditOverlay,
        'dirty_value' | 'dirty_display' | 'dirty_rich' | 'diff_base'
            | 'formula_result_pending' | 'formula_result'
    > | undefined => {
        const formula_is_affected = pending_formula_impact_ref.current
            ?.has(source_row, source_column) === true;
        const calculated_formula_result = calculated_formula_result_for_cell(
            source_row,
            source_column,
            key,
            cell,
            formula_is_affected,
        );
        if (dirty) {
            const dirty_overlay = dirty_value_overlay_fields(
                dirty,
                diff_mode,
                show_formatting,
                cell,
                edit_syntax === 'markdown',
                calculated_formula_result,
            );
            if (dirty_overlay) return dirty_overlay;
        }
        if (
            cell?.formula === undefined
            || (!formula_is_affected && calculated_formula_result === undefined)
        ) return undefined;
        return calculated_formula_result === undefined
            ? { formula_result_pending: true }
            : { formula_result: calculated_formula_result };
    }, [
        calculated_formula_result_for_cell,
        diff_mode,
        edit_syntax,
        show_formatting,
    ]);

    // Tint set = what the webview can derive ∪ what the host named. The union is
    // what everything downstream consumes (the paint callback's ref, the targeted
    // repaint effect's diff, and the status reported to App), so a host-named cell
    // is marked and un-marked by exactly the same machinery as a derived one. Only
    // keys the store actually holds are included: a stale rejection naming an
    // already-discarded edit must not keep tinting, and `dirty_cells` is what
    // decides whether a cell is painted with an overlay at all.
    //
    // The legacy `conflicted` field reported up to App stays this union too. It now
    // means only "pending edits whose file side changed"; retaining the wire-shaped
    // name keeps this refactor local while the UI uses accurate language.
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
    // Host row admission temporarily withholds every editing affordance, but its
    // own answer still has to be installable while that busy render is committed.
    // Keep the underlying activation separate so the post-await fence can ignore
    // only this request's `append_in_flight` affordance, while still observing a
    // save, highlight, close barrier, or deactivated edit session.
    const append_admission_active = edit_mode
        && csv_editable
        && !save_in_flight
        && !highlight_in_flight
        && !close_barrier_active;
    const editable_cells = append_admission_active && !append_in_flight;
    // Stable row identities let cuts survive harmless sort/filter/projection
    // changes. Numeric fallback coordinates retain a separate generation guard.
    const clipboard_source = sheet_meta.worksheetId
        ?? `${sheet_index}:${sheet_meta.name}`;
    // Edit callbacks can outlive the render that supplied them. Read admission
    // through refs updated only by the committed tree: mutating them during render
    // would let an abandoned concurrent render change the mounted callbacks' view.
    const editable_cells_ref = useRef(editable_cells);
    const append_admission_active_ref = useRef(append_admission_active);
    const edit_session_id_ref = useRef(edit_session_id);
    useLayoutEffect(() => {
        editable_cells_ref.current = editable_cells;
        append_admission_active_ref.current = append_admission_active;
        edit_session_id_ref.current = edit_session_id;
        return () => {
            // Async append admissions retain the callback that requested them.
            // Once this committed grid is replaced, that callback must not be
            // able to mutate its detached pending-row store.
            editable_cells_ref.current = false;
            append_admission_active_ref.current = false;
            edit_session_id_ref.current = undefined;
        };
    }, [append_admission_active, editable_cells, edit_session_id]);

    useEffect(() => {
        if (
            !save_operation
            || save_operation.editSessionId !== edit_session_id
            || csv_save_operations_equal(save_operation_ref.current, save_operation)
        ) return;
        const worksheet = worksheet_payload(save_operation);
        save_operation_ref.current = save_operation;
        saved_edits_ref.current = worksheet ? { ...worksheet.edits } : {};
        save_in_flight_ref.current = true;
        set_save_in_flight(true);
    }, [edit_session_id, save_operation, worksheet_payload]);

    const apply_save_lifecycle = useCallback((lifecycle: CsvSaveLifecycle) => {
        if (!is_valid_csv_save_lifecycle(lifecycle)) return;
        if (lifecycle.revision <= applied_save_lifecycle_revision_ref.current) return;
        applied_save_lifecycle_revision_ref.current = lifecycle.revision;
        if (lifecycle.state === 'active') {
            const operation = lifecycle.operation;
            if (operation.editSessionId !== edit_session_id) return;
            const locked = save_operation_ref.current;
            if (locked && !csv_save_operations_equal(locked, operation)) return;
            const worksheet = worksheet_payload(operation);
            save_operation_ref.current = operation;
            saved_edits_ref.current = worksheet ? { ...worksheet.edits } : {};
            if (worksheet) replace_dirty(worksheet.dirtyEdits);
            save_in_flight_ref.current = true;
            set_save_in_flight(true);
            return;
        }

        const operation = save_operation_ref.current;
        // Idle carries no proposal identity, so it cannot settle an operation that
        // may have been proposed after that idle projection was created.
        if (lifecycle.state === 'idle' || !operation) return;
        const correlation = save_lifecycle_correlation(lifecycle);
        if (!correlation || (
            lifecycle.state === 'failed'
                ? correlation.editSessionId !== edit_session_id
                : edit_session_id !== undefined
                    && correlation.editSessionId !== edit_session_id
        )) return;
        if (!terminal_csv_save_settles_operation(lifecycle, operation)) return;

        const pending = Object.fromEntries(store.snapshot());
        const worksheet = worksheet_payload(operation);
        const restore: CsvDirtyMap = worksheet === undefined
            ? pending
            : lifecycle.state === 'failed'
                ? worksheet.dirtyEdits
                : remove_operation_owned_pending_edits(pending, worksheet) ?? {};
        // Release the lock before publishing the recovered map. The hydration and
        // store boundaries make malformed proposals a safe no-op/fallback; keeping
        // the flags first also guarantees the next request is admissible as soon as
        // subscribers observe that recovery.
        save_operation_ref.current = undefined;
        saved_edits_ref.current = {};
        save_in_flight_ref.current = false;
        set_save_in_flight(false);
        replace_dirty(restore);
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
            is_dirty: dirty_cells.size > 0 || has_pending_structural_changes(pending_rows),
            has_live_uncommitted: live_uncommitted,
            save_in_flight,
            edits: Object.fromEntries(dirty_cells),
            conflicted: [...conflicted_keys],
        });
    }, [
        dirty_cells,
        conflicted_keys,
        live_uncommitted,
        on_editing_change,
        pending_rows,
        save_in_flight,
    ]);

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
        if (edit_admission_is_fenced()) {
            return pending_changes_durability.snapshot(edit_session_id)
                .highestProducedSequence;
        }
        // This shell's own sheet, index and name both: the session is
        // workbook-scoped, so the post names the slot it is a complete map of,
        // and the name lets the host follow the sheet through a reorder that
        // lands while the write is queued.
        const changes: WorksheetPendingChanges = Object.freeze({
            sheetIndex: sheet_index,
            sheetName: sheet_meta.name,
            ...(sheet_meta.worksheetId === undefined
                ? {}
                : { worksheetId: sheet_meta.worksheetId }),
            cells: Object.freeze({ ...(edits ?? {}) }),
            ...pending_store.snapshot(),
        });
        return pending_changes_durability.publish(
            edit_session_id,
            changes,
            source_generation,
            force,
        );
    }, [
        edit_admission_is_fenced,
        edit_session_id,
        sheet_index,
        sheet_meta.name,
        sheet_meta.worksheetId,
        pending_store,
        source_generation,
    ]);

    // Persist a complete dirty map under a renderer-monotonic sequence. The host
    // acknowledges only after the corresponding state-store write resolves.
    useEffect(() => {
        if (!edit_mode || !edit_session_id || save_in_flight_ref.current) return;
        post_pending_edits(
            dirty_cells.size > 0 ? Object.fromEntries(dirty_cells) : null,
        );
    }, [
        dirty_cells,
        edit_mode,
        edit_session_id,
        pending_rows,
        post_pending_edits,
        save_in_flight,
    ]);

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
    const pending_active_cell = useCallback(() => {
        const cell = grid_selection_ref.current.current?.cell;
        if (cell === undefined) return undefined;
        const projected = pending_projection.row_at(cell[1]);
        if (projected?.kind !== 'pending' && projected?.kind !== 'replacement') {
            return undefined;
        }
        const source_column = source_column_for_display(cell[0]);
        return source_column === undefined ? undefined : {
            pendingRowId: projected.row.id,
            sourceColumn: source_column,
        };
    }, [pending_projection, source_column_for_display]);
    useLayoutEffect(() => {
        if (!grid_focus_ref) return;
        const handle: GridFocusHandle = {
            generation,
            has_focus: () => grid_owns_focus(
                grid_root_ref.current,
                document.activeElement,
            ),
            focus: focus_grid,
            pending_active_cell,
        };
        grid_focus_ref.current = handle;
        return () => {
            if (grid_focus_ref.current === handle) grid_focus_ref.current = null;
        };
    }, [focus_grid, generation, grid_focus_ref, pending_active_cell]);
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
        const source_intervals = pending_projection.source_display_intervals(
            request.display_rows,
        );
        const pending_ids = new Set<string>();
        const removal_rows = new Set<number>();
        for (const interval of request.display_rows) {
            for (
                let row = Math.max(interval.start, pending_projection.deletedBandStart);
                row <= interval.end;
                row += 1
            ) {
                const projected = pending_projection.row_at(row);
                if (
                    projected?.kind === 'removal'
                    || projected?.kind === 'replacement'
                ) removal_rows.add(projected.removal.sourceRow);
                if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
                    pending_ids.add(projected.row.id);
                }
            }
        }
        set_context_menu({
            kind: 'row',
            x: request.x,
            y: request.y,
            row: request.row,
            row_number: typeof row_marker_options === 'string'
                ? request.row + 1
                : row_marker_options.getRowNumber(request.row) ?? request.row + 1,
            selected_row_count: request.display_rows.reduce(
                (total, interval) => total + interval.end - interval.start + 1,
                0,
            ),
            source_display_rows: source_intervals,
            pending_row_ids: [...pending_ids],
            tail_removal_source_rows: [...removal_rows],
        });
    }, [pending_projection, row_marker_options]);
    const row_markers = use_row_marker_selection({
        row_count,
        selection_ref: grid_selection_ref,
        set_selection: (selection) => {
            deferred_pending_topology_selection_ref.current = null;
            grid_selection_ref.current = selection;
            set_grid_selection(selection);
        },
        on_open_menu: open_row_marker_menu,
    });
    const current_highlight_selection = useCallback(() => {
        const selection = highlight_selection_from_grid(
            grid_selection_ref.current,
            row_count,
            column_projection,
            merges,
        )?.selection;
        if (selection === undefined) return null;
        const has_highlightable_row = selection.displayRows.some((interval) => (
            interval.start < pending_projection.deletedBandStart
            || interval.end >= pending_projection.pendingBandStart
        ));
        return has_highlightable_row ? selection : null;
    }, [column_projection, merges, pending_projection, row_count]);
    const mutate_highlight_selection = useCallback((mutation: CellHighlightMutation): boolean => {
        if (gestures_admitted !== undefined && !gestures_admitted()) return false;
        const selection = current_highlight_selection();
        if (!selection) return false;
        const compressed_source_intervals: DisplayRowInterval[] = [];
        const pending_ids = new Set<string>();
        for (const interval of selection.displayRows) {
            const source_end = Math.min(
                interval.end,
                pending_projection.deletedBandStart - 1,
            );
            if (source_end >= interval.start) {
                compressed_source_intervals.push({ start: interval.start, end: source_end });
            }
            for (
                let row = Math.max(interval.start, pending_projection.pendingBandStart);
                row <= interval.end;
                row += 1
            ) {
                const projected = pending_projection.row_at(row);
                if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
                    pending_ids.add(projected.row.id);
                }
            }
        }
        const source_intervals = pending_projection.source_display_intervals(
            compressed_source_intervals,
        );
        if (pending_ids.size === 0) {
            if (source_intervals.length > 0) {
                on_highlight_selection({
                    ...selection,
                    displayRows: source_intervals,
                }, mutation);
            }
            return source_intervals.length > 0;
        }
        const before = pending_store.snapshot();
        const after: PendingStructuralChanges = {
            ...before,
            appendedRows: before.appendedRows.map((row) => {
                if (!pending_ids.has(row.id)) return row;
                const highlights: Record<string, CellHighlightColor> = {
                    ...(row.highlights ?? {}),
                };
                for (const column of selection.sourceColumns) {
                    if (mutation.type === 'set') highlights[column] = mutation.color;
                    else delete highlights[column];
                }
                return {
                    ...row,
                    ...(Object.keys(highlights).length === 0
                        ? { highlights: undefined }
                        : { highlights }),
                };
            }),
        };
        const refusal_before = envelope_refusal_sequence_ref.current;
        const pending_stage = pending_store.stage_replace(edit_session_id, before, after);
        if (pending_stage === undefined) {
            if (envelope_refusal_sequence_ref.current !== refusal_before) {
                show_pending_size_warning();
            }
            return false;
        }
        const label = mutation.type === 'set' ? 'Highlight cells' : 'Clear highlights';
        if (source_intervals.length === 0) {
            const changes = pending_row_history_changes(
                history_capture?.worksheet ?? {
                    sheetIndex: sheet_index,
                    ...(sheet_meta.name === undefined ? {} : { sheetName: sheet_meta.name }),
                    ...(sheet_meta.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet_meta.worksheetId }),
                },
                before,
                after,
            );
            const participants: StagedMutation[] = [pending_stage];
            if (history_capture !== undefined && changes.length > 0) {
                participants.push(history_capture.history.stage_record({ label, changes }));
            }
            return commit_staged_transaction(participants);
        }
        const pending_changes = pending_row_history_changes(
            history_capture?.worksheet ?? {
                sheetIndex: sheet_index,
                ...(sheet_meta.name === undefined ? {} : { sheetName: sheet_meta.name }),
                ...(sheet_meta.worksheetId === undefined
                    ? {}
                    : { worksheetId: sheet_meta.worksheetId }),
            },
            before,
            after,
        );
        const pending_gesture: PendingHostGesture = {
            commit: (source_changes, gesture_label) => {
                const participants: StagedMutation[] = [pending_stage];
                if (history_capture !== undefined) {
                    participants.push(history_capture.history.stage_record({
                        label: gesture_label,
                        changes: [...source_changes, ...pending_changes],
                    }));
                }
                return commit_staged_transaction(participants);
            },
            cancel: () => {},
        };
        on_highlight_selection({
            ...selection,
            displayRows: source_intervals,
        }, mutation, pending_gesture);
        return true;
    }, [
        current_highlight_selection,
        edit_session_id,
        gestures_admitted,
        history_capture,
        on_highlight_selection,
        pending_projection,
        pending_store,
        sheet_index,
        sheet_meta.name,
        sheet_meta.worksheetId,
        show_pending_size_warning,
    ]);
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
    const write_grid_selection = useCallback((
        selection: GridSelection,
        preserve_deferred_topology = false,
    ) => {
        if (!preserve_deferred_topology) {
            deferred_pending_topology_selection_ref.current = null;
        }
        if (selection.current) {
            focused_source_column_ref.current = source_column_for_display(
                selection.current.cell[0],
            );
        }
        grid_selection_ref.current = selection;
        set_grid_selection(selection);
    }, [source_column_for_display]);
    useLayoutEffect(() => {
        const previous = committed_pending_projection_ref.current;
        const previous_key = committed_pending_projection_key_ref.current;
        let captured = pending_topology_selection_ref.current;
        pending_topology_selection_ref.current = null;
        committed_pending_projection_ref.current = pending_projection;
        committed_pending_projection_key_ref.current = pending_selection_topology_key;
        const topology_changed = previous_key !== pending_selection_topology_key;
        // Menu callbacks capture numeric display coordinates. Any pending-row
        // topology change can put a different identity at that coordinate, so
        // close before the user can invoke an action against the replacement.
        if (topology_changed) set_context_menu(null);
        const deferred = deferred_pending_topology_selection_ref.current;
        if (
            deferred !== null
            && deferred.activeCandidateSourceRows.size === 0
            && deferred.topologyKey === pending_selection_topology_key
        ) {
            deferred_pending_topology_selection_ref.current = null;
            write_grid_selection(deferred.selection, true);
            return;
        }
        let restored_deferred = false;
        if (deferred !== null && deferred.candidates.every((candidate) => (
            pending_projection.display_row_for_identity(candidate.identity) !== undefined
            || candidate.identity.kind === 'source'
                && resolved_source_display_rows.generation === generation
                && resolved_source_display_rows.mappingGeneration === mapping_generation
                && resolved_source_display_rows.rows.has(candidate.identity.sourceRow)
        ))) {
            captured = capture_pending_topology_selection(
                deferred.selection,
                deferred.projection,
                deferred.candidates.map(({ identity }) => {
                    const old_display_row = identity.kind === 'source'
                        ? authoritative_display_row_for_source(identity.sourceRow)
                        : undefined;
                    return {
                        identity,
                        ...(old_display_row === undefined ? {} : { oldDisplayRow: old_display_row }),
                    };
                }),
            );
            deferred_pending_topology_selection_ref.current = null;
            restored_deferred = true;
        }
        if (!topology_changed && !restored_deferred) return;
        if (captured === null && previous !== null && previous !== pending_projection) {
            // Projection-only topology changes (notably a transformed removal's
            // inverse lookup resolving) have no store notification from which to
            // capture. The last committed projection still owns the current
            // numeric selection, so take the same identity snapshot here.
            captured = capture_pending_topology_selection(
                grid_selection_ref.current,
                previous,
                pending_rows.tailRemovals.map((removal) => {
                    const resolved = resolved_source_display_rows.generation === generation
                        && resolved_source_display_rows.mappingGeneration === mapping_generation
                        ? resolved_source_display_rows.rows.get(removal.sourceRow)
                        : undefined;
                    return {
                        identity: {
                            kind: 'source' as const,
                            sourceRow: removal.sourceRow,
                        },
                        ...(typeof resolved === 'number'
                            ? { oldDisplayRow: resolved }
                            : {}),
                    };
                }),
            );
        }
        if (captured === null) return;
        write_grid_selection(remap_pending_topology_selection(
            captured,
            pending_projection,
        ), true);
    }, [
        authoritative_display_row_for_source,
        pending_selection_topology_key,
        pending_projection,
        write_grid_selection,
    ]);
    const select_active_display_cell = useCallback((target: Item) => {
        // Merge snapping is required here: the vendored grid's canonicalization
        // chokepoint (setGridSelection) covers selections *it* originates —
        // mouse, keyboard, a11y — not controlled writes, which render as
        // handed. It also keeps grid_selection_ref correct synchronously (the
        // context menu and highlight paths read it before any grid
        // round-trip).
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
    const reveal_pending_row = useCallback((pending_row_id: string): boolean => {
        const display_row = pending_projection.display_row_for_identity({
            kind: 'pending',
            pendingRowId: pending_row_id,
        });
        if (display_row === undefined || display_column_count === 0) return false;
        select_active_display_cell([0, display_row]);
        focus_grid();
        return true;
    }, [display_column_count, focus_grid, pending_projection, select_active_display_cell]);
    const remove_pending_rows = useCallback((pending_row_ids: readonly string[]): boolean => {
        if (edit_admission_is_fenced() || save_in_flight_ref.current
            || (gestures_admitted !== undefined && !gestures_admitted())) return false;
        const ids = new Set(pending_row_ids);
        if (ids.size === 0) return false;
        const before = pending_store.snapshot();
        const removed = pending_store.remove_rows(edit_session_id, ids);
        if (removed === undefined || removed.length === 0) return false;
        record_pending_row_gesture(
            removed.length === 1 ? 'Remove pending row' : 'Remove pending rows',
            before,
            pending_store.snapshot(),
        );
        write_grid_selection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
        });
        focus_grid();
        return true;
    }, [
        edit_admission_is_fenced,
        edit_session_id,
        focus_grid,
        gestures_admitted,
        pending_store,
        record_pending_row_gesture,
        save_in_flight_ref,
        write_grid_selection,
    ]);
    const reveal_tail_removal = useCallback((append_history_id: string): boolean => {
        const display_row = pending_projection.display_row_for_tail_removal_id(
            append_history_id,
        );
        if (display_row === undefined || display_column_count === 0) return false;
        select_active_display_cell([0, display_row]);
        focus_grid();
        return true;
    }, [display_column_count, focus_grid, pending_projection, select_active_display_cell]);
    const cancel_tail_removals = useCallback((append_history_ids: readonly string[]): boolean => {
        if (edit_admission_is_fenced() || save_in_flight_ref.current
            || (gestures_admitted !== undefined && !gestures_admitted())) return false;
        const ids = new Set(append_history_ids);
        if (ids.size === 0) return false;
        const before = pending_store.snapshot();
        const next = tail_removals_after_cancellation(before.tailRemovals, ids);
        if (next === undefined) return false;
        if (next.length === before.tailRemovals.length) return false;
        const changed = pending_store.replace_tail_removals(edit_session_id, next);
        if (!changed) return false;
        record_pending_row_gesture(
            next.length + 1 === before.tailRemovals.length
                ? 'Cancel row removal'
                : 'Cancel row removals',
            before,
            pending_store.snapshot(),
        );
        write_grid_selection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
        });
        focus_grid();
        return true;
    }, [
        edit_admission_is_fenced,
        edit_session_id,
        focus_grid,
        gestures_admitted,
        pending_store,
        record_pending_row_gesture,
        save_in_flight_ref,
        write_grid_selection,
    ]);
    const rows_are_projected = transform_state.sort.length > 0
        || transform_state.filters.length > 0
        || (transform_state.hiddenRows?.length ?? 0) > 0
        || transform_state.onlyChangedRows === true;
    const unloaded_display_row_for_source = useCallback((source_row: number) => {
        if (rows_are_projected || source_row < 0) return undefined;
        const header = sheet_meta.excelFirstRowHeader;
        if (header?.active === true) {
            const promoted = header.sourceRow ?? 0;
            if (source_row === promoted) return undefined;
            const display_row = source_row < promoted ? source_row : source_row - 1;
            return display_row < row_count ? display_row : undefined;
        }
        return source_row < row_count ? source_row : undefined;
    }, [row_count, rows_are_projected, sheet_meta.excelFirstRowHeader]);
    const can_reveal_source_cell = useCallback((
        source_row: number,
        source_column: number,
    ): boolean => {
        if (display_column_for_source(source_column) === undefined) return false;
        return pending_projection.display_row_for_identity({
            kind: 'source',
            sourceRow: source_row,
        }) !== undefined
            || unloaded_display_row_for_source(source_row) !== undefined;
    }, [
        display_column_for_source,
        pending_projection,
        unloaded_display_row_for_source,
    ]);
    const reveal_source_cell = useCallback(async (
        source_row: number,
        source_column: number,
        is_current?: () => boolean,
        restore_focus = true,
    ): Promise<boolean> => {
        if (is_current?.() === false) return false;
        const display_column = display_column_for_source(source_column);
        if (display_column === undefined) return false;
        let display_row = pending_projection.display_row_for_identity({
            kind: 'source',
            sourceRow: source_row,
        });
        if (display_row === undefined) {
            const loader_row = authoritative_display_row_for_source(source_row)
                ?? unloaded_display_row_for_source(source_row);
            if (loader_row === undefined) return false;
            const loaded = await ensure_rows_loaded(loader_row, loader_row);
            if (!loaded) return false;
            if (is_current?.() === false) return false;
            display_row = pending_projection.display_row_for_identity({
                kind: 'source',
                sourceRow: source_row,
            });
        }
        if (display_row === undefined) return false;
        if (is_current?.() === false) return false;
        select_active_display_cell([display_column, display_row]);
        if (restore_focus) focus_grid();
        return true;
    }, [
        authoritative_display_row_for_source,
        display_column_for_source,
        ensure_rows_loaded,
        focus_grid,
        pending_projection,
        select_active_display_cell,
        unloaded_display_row_for_source,
    ]);
    const applied_saved_row_focus_ref = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (saved_row_focus === null || saved_row_focus.sheetIndex !== sheet_index) return;
        if (applied_saved_row_focus_ref.current === saved_row_focus.sequence) return;
        // SaveResult precedes the post-save source snapshot. Keep the request alive
        // until the source extent proves the newly materialized row exists.
        if (saved_row_focus.sourceRow >= sheet_meta.sourceRowCount) return;
        if (transform_pending) return;
        if (
            rows_are_projected
            && get_display_row_for_source(saved_row_focus.sourceRow) === undefined
            && (
                resolved_source_display_rows.generation !== generation
                || resolved_source_display_rows.mappingGeneration !== mapping_generation
                || !resolved_source_display_rows.rows.has(saved_row_focus.sourceRow)
            )
        ) return;
        applied_saved_row_focus_ref.current = saved_row_focus.sequence;
        if (!can_reveal_source_cell(
            saved_row_focus.sourceRow,
            saved_row_focus.sourceColumn,
        )) {
            if (saved_row_focus.restoreFocus) focus_grid();
            on_saved_row_focus_applied(saved_row_focus.sequence, false);
            return;
        }
        void reveal_source_cell(
            saved_row_focus.sourceRow,
            saved_row_focus.sourceColumn,
            undefined,
            saved_row_focus.restoreFocus,
        ).then((visible) => {
            on_saved_row_focus_applied(saved_row_focus.sequence, visible);
        });
    }, [
        on_saved_row_focus_applied,
        can_reveal_source_cell,
        focus_grid,
        generation,
        get_display_row_for_source,
        mapping_generation,
        reveal_source_cell,
        resolved_source_display_rows,
        rows_are_projected,
        saved_row_focus,
        sheet_index,
        sheet_meta.sourceRowCount,
        transform_pending,
    ]);
    const applied_pending_row_focus_ref = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (pending_row_focus === null || pending_row_focus.sheetIndex !== sheet_index) return;
        if (applied_pending_row_focus_ref.current === pending_row_focus.sequence) return;
        const display_row = pending_projection.display_row_for_identity({
            kind: 'pending',
            pendingRowId: pending_row_focus.pendingRowId,
        });
        const display_column = display_column_for_source(pending_row_focus.sourceColumn);
        applied_pending_row_focus_ref.current = pending_row_focus.sequence;
        if (display_row === undefined || display_column === undefined) {
            if (pending_row_focus.restoreFocus) focus_grid();
            on_pending_row_focus_applied(pending_row_focus.sequence, false);
            return;
        }
        select_active_display_cell([display_column, display_row]);
        if (pending_row_focus.restoreFocus) focus_grid();
        on_pending_row_focus_applied(pending_row_focus.sequence, true);
    }, [
        display_column_for_source,
        focus_grid,
        on_pending_row_focus_applied,
        pending_projection,
        pending_row_focus,
        select_active_display_cell,
        sheet_index,
    ]);
    // The flash lives in a ref, not state: `get_cell_content` reads it during
    // paint, and a re-render is neither needed nor wanted — the visible cells are
    // damaged explicitly, twice, on entry and at the deadline.
    const history_flash_ref = useRef<HistoryFlash | null>(null);
    const history_flash_timer_ref = useRef<number | null>(null);
    const applied_history_sequence_ref = useRef<number | null>(null);

    /**
     * Repaint the cells a flash covers, whatever `history_flash_ref` now holds.
     *
     * Both callers pass the same flash and want the same cells; what differs is
     * only when they run relative to installing or clearing it. Bounded by the
     * viewport, which is what keeps a select-all-sized replay from enumerating a
     * million cells — `history_flash_damage` intersects with the visible rect.
     */
    const repaint_history_flash = useCallback((flash: HistoryFlash) => {
        const cells = history_flash_damage(flash, visible_ref.current)
            .map(({ cell }) => ({ cell: cell as Item }));
        if (cells.length > 0) grid_ref.current?.updateCells(cells);
    }, []);

    const clear_history_flash = useCallback(() => {
        if (history_flash_timer_ref.current !== null) {
            window.clearTimeout(history_flash_timer_ref.current);
            history_flash_timer_ref.current = null;
        }
        const flash = history_flash_ref.current;
        history_flash_ref.current = null;
        if (flash === null) return;
        // Repainted AFTER clearing, so it reads the cleared state and the cells
        // come back with whatever persistent tint they actually have — conflict,
        // dirty, or a cell highlight.
        repaint_history_flash(flash);
    }, [repaint_history_flash]);

    useEffect(() => clear_history_flash, [clear_history_flash]);

    /**
     * Move the cursor to what an undo or redo changed, and flash it.
     *
     * A layout effect so the selection is written before the browser paints: a
     * cross-sheet replay arrives with this grid freshly mounted, and a visible
     * frame at the old cursor before it jumps reads as a glitch.
     */
    useLayoutEffect(() => {
        if (history_focus === null) return;
        if (applied_history_sequence_ref.current === history_focus.sequence) return;
        // Before resolving, not after: a request for another sheet is not this
        // grid's to answer OR to refuse — App is mid-switch and the grid that can
        // honour it has yet to mount — so there is nothing to resolve.
        if (history_focus.sheetIndex !== sheet_index) return;
        const outcome = resolve_history_focus(history_focus, {
            rowCount: row_count,
            mappingGeneration: mapping_generation,
            columnProjection: column_projection,
        });
        applied_history_sequence_ref.current = history_focus.sequence;
        if (outcome.kind !== 'applied') {
            on_history_focus_applied(history_focus.sequence, outcome);
            return;
        }
        // Merge snapping, for the reason `select_active_display_cell` documents:
        // controlled writes bypass the grid's own canonicalization, so a region
        // overlapping a merge would render as a partial block.
        const { cell, range } = expand_glide_selection(outcome.cell, outcome.range, merges);
        write_grid_selection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: { cell, range, rangeStack: [] },
        });
        // A replay should lead the eye to the start of an oversized cell. Glide's
        // default nearest-edge reveal can otherwise show its right edge and leave
        // the value offscreen; fitting cells retain ordinary nearest-edge behavior.
        grid_ref.current?.scrollTo(cell[0], cell[1], 'both', 0, 0, {
            hAlign: 'start-if-oversized',
        });
        focus_grid();

        clear_history_flash();
        const flash = begin_history_flash(range, Date.now());
        history_flash_ref.current = flash;
        repaint_history_flash(flash);
        // No same-flash guard in the callback: a newer replay reaches
        // `clear_history_flash` above before installing its own flash, and that
        // cancels this timer — so if this ever runs, the flash it was armed for is
        // still the installed one.
        history_flash_timer_ref.current = window.setTimeout(
            clear_history_flash,
            HISTORY_FLASH_DURATION_MS,
        );
        on_history_focus_applied(history_focus.sequence, outcome);
    }, [
        clear_history_flash,
        column_projection,
        display_column_count,
        focus_grid,
        history_focus,
        mapping_generation,
        merges,
        on_history_focus_applied,
        row_count,
        sheet_index,
        write_grid_selection,
    ]);

    const select_active_display_cell_ref = useRef(select_active_display_cell);
    const focus_grid_ref = useRef(focus_grid);
    const row_count_ref = useRef(row_count);
    const display_column_count_ref = useRef(display_column_count);
    const merge_index_ref = useRef(merge_index);
    useLayoutEffect(() => {
        select_active_display_cell_ref.current = select_active_display_cell;
        focus_grid_ref.current = focus_grid;
        row_count_ref.current = row_count;
        display_column_count_ref.current = display_column_count;
        merge_index_ref.current = merge_index;
    }, [
        select_active_display_cell,
        focus_grid,
        row_count,
        display_column_count,
        merge_index,
    ]);
    const previous_projection_ref = useRef(column_projection);
    useLayoutEffect(() => {
        if (column_projections_equal(previous_projection_ref.current, column_projection)) {
            previous_projection_ref.current = column_projection;
            return;
        }
        previous_projection_ref.current = column_projection;
        // A controlled selection reset and a new provideEditor callback do not
        // reliably close an overlay Glide already mounted. App folds its live
        // value before changing a projection; explicitly terminate the old
        // display-coordinate lifetime before display columns acquire new
        // meanings.
        grid_ref.current?.dismissOverlay();
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

    const can_request_append_rows = editable_cells
        && on_append_rows !== undefined
        && edit_session_id !== undefined
        && sheet_meta.columnCount > 0
        && has_visible_columns;
    const may_append_rows = can_request_append_rows
        && pending_rows.appendedRows.length < MAX_PENDING_APPENDED_ROWS
        && sheet_meta.sourceRowCount
            - pending_rows.tailRemovals.length
            + pending_rows.appendedRows.length < append_row_ceiling;
    const append_capacity = useCallback((count: number) => {
        const current = pending_store.snapshot();
        return Number.isSafeInteger(count)
            && count > 0
            && current.appendedRows.length + count <= MAX_PENDING_APPENDED_ROWS
            && sheet_meta.sourceRowCount
                - current.tailRemovals.length
                + current.appendedRows.length
                + count <= append_row_ceiling;
    }, [append_row_ceiling, pending_store, sheet_meta.sourceRowCount]);
    /**
     * How many more rows this gesture may stage right now — the smaller of the
     * two capacities the dock clamps its count control against. Read from
     * rendered pending state rather than the store snapshot, because it drives
     * what the user sees; `append_capacity` re-checks the live snapshot at
     * admission time.
     */
    const remaining_append_capacity = Math.max(0, Math.min(
        MAX_PENDING_APPENDED_ROWS - pending_rows.appendedRows.length,
        append_row_ceiling
            - sheet_meta.sourceRowCount
            + pending_rows.tailRemovals.length
            - pending_rows.appendedRows.length,
    ));
    /**
     * Whether the append dock is offered at all. Deliberately not
     * `may_append_rows`: that folds in `append_in_flight`, which is the fence
     * for the request the dock itself issued. Unmounting the dock under its own
     * request would replace the busy state with a disappearing control, so the
     * dock stays mounted across the round trip and renders `busy` instead.
     */
    const may_offer_append_dock = append_admission_active
        && on_append_rows !== undefined
        && edit_session_id !== undefined
        && sheet_meta.columnCount > 0
        && has_visible_columns
        && remaining_append_capacity > 0;
    const get_row_accessibility_label = useCallback((row: number) => {
        const projected = pending_projection.row_at(row);
        if (projected?.kind === 'pending') {
            const label = `Pending appended row ${projected.intendedPhysicalRow + 1}`;
            return row === pending_projection.pendingBandStart
                ? `Pending rows divider. ${label}`
                : label;
        }
        if (projected?.kind === 'replacement') {
            const label = `Pending replacement row ${projected.intendedPhysicalRow + 1}`;
            return row === pending_projection.pendingBandStart
                ? `Pending rows divider. ${label}`
                : label;
        }
        if (projected?.kind === 'removal') {
            return `Pending tail removal row ${projected.intendedPhysicalRow + 1}`;
        }
        return undefined;
    }, [pending_projection]);
    const draw_pending_divider = useCallback<
        NonNullable<React.ComponentProps<typeof DataEditor>['drawCell']>
    >((args, draw_content) => {
        draw_content();
        if (
            pending_rows.appendedRows.length === 0
            || args.row !== pending_projection.pendingBandStart
        ) return;
        args.ctx.save();
        args.ctx.fillStyle = args.theme.accentColor;
        // Keep the visual divider on the row boundary. A previous in-cell badge
        // covered the first pending cell's text and click target.
        args.ctx.fillRect(args.rect.x, args.rect.y, args.rect.width, 2);
        args.ctx.restore();
    }, [pending_projection.pendingBandStart, pending_rows.appendedRows.length]);
    const append_admission_tail_ref = useRef<Promise<void>>(Promise.resolve());
    const admit_pending_rows = useCallback((
        count: number,
        record_history = true,
        still_current: () => boolean = () => true,
    ) => {
        // Capture the activation before joining the serialization tail. The
        // first request's busy affordance may render while a second gesture is
        // queued; that affordance must not retroactively cancel the gesture.
        const activation_admitted = may_append_rows
            && on_append_rows !== undefined
            && append_admission_active_ref.current
            && edit_session_id_ref.current === edit_session_id
            && pending_store.identity()?.session_id === edit_session_id
            && append_capacity(count);
        const execute = async () => {
            if (
                !activation_admitted
                || on_append_rows === undefined
                || !append_admission_active_ref.current
                || edit_session_id_ref.current !== edit_session_id
                || pending_store.identity()?.session_id !== edit_session_id
                || !append_capacity(count)
                || !still_current()
            ) {
                if (can_request_append_rows) {
                    const current = pending_store.snapshot();
                    host_bridge.postMessage({
                        type: 'showWarning',
                        message: current.appendedRows.length + count
                            > MAX_PENDING_APPENDED_ROWS
                            ? `A worksheet may keep at most ${MAX_PENDING_APPENDED_ROWS.toLocaleString('en-US')} pending rows.`
                            : 'Appending another row would exceed the worksheet row limit.',
                    });
                }
                return undefined;
            }
            const admitted = await on_append_rows(count);
            if (admitted === undefined) return undefined;
            if (admitted.rowIds.length !== count) {
                admitted.settle(false);
                return undefined;
            }
            if (
                edit_admission_is_fenced()
                || save_in_flight_ref.current
                || !append_admission_active_ref.current
                || edit_session_id_ref.current !== edit_session_id
                || pending_store.identity()?.session_id !== edit_session_id
                || !append_capacity(count)
                || !still_current()
            ) {
                admitted.settle(false);
                return undefined;
            }
            const before = pending_store.snapshot();
            const refusal_before = envelope_refusal_sequence_ref.current;
            const added = pending_store.append_rows(
                edit_session_id,
                admitted.rowIds,
                admitted.formatTemplate,
                issue_value_edit_order(),
                admitted.appendBasis,
            );
            if (!added) {
                admitted.settle(false);
                if (envelope_refusal_sequence_ref.current !== refusal_before) {
                    show_pending_size_warning();
                } else {
                    host_bridge.postMessage({
                        type: 'showWarning',
                        message: 'The row could not be added because the pending worksheet changed.',
                    });
                }
                return undefined;
            }
            admitted.settle(true);
            if (record_history) {
                record_pending_row_gesture(
                    count === 1 ? 'Append row' : `Append ${count} rows`,
                    before,
                    pending_store.snapshot(),
                );
            }
            return { rowIds: admitted.rowIds, before };
        };
        const result = append_admission_tail_ref.current.then(execute, execute);
        append_admission_tail_ref.current = result.then(() => undefined, () => undefined);
        return result;
    }, [
        edit_session_id,
        edit_admission_is_fenced,
        append_capacity,
        can_request_append_rows,
        issue_value_edit_order,
        may_append_rows,
        on_append_rows,
        pending_rows.appendedRows.length,
        pending_store,
        record_pending_row_gesture,
        show_pending_size_warning,
    ]);
    const pending_display_row = useCallback((pending_row_id: string): Promise<
        number | undefined
    > => new Promise((resolve) => {
        let attempts = 0;
        const poll = () => {
            const display_row = pending_projection_ref.current.display_row_for_identity({
                kind: 'pending',
                pendingRowId: pending_row_id,
            });
            if (display_row !== undefined) {
                resolve(display_row);
                return;
            }
            attempts += 1;
            if (attempts >= 120) {
                resolve(undefined);
                return;
            }
            window.requestAnimationFrame(poll);
        };
        poll();
    }), []);
    const pending_paste_history_ref = useRef<{
        readonly before: PendingStructuralChanges;
        readonly rowIds: ReadonlySet<string>;
    } | null>(null);
    const append_rows_for_paste = useCallback(async (
        count: number,
        expected_topology_key: unknown,
    ): Promise<
        false | { readonly topologyKey: unknown; readonly rollback: () => void }
    > => {
        pending_paste_history_ref.current = null;
        const appended = await admit_pending_rows(
            count,
            false,
            () => paste_topology_key_ref.current === expected_topology_key,
        );
        if (appended === undefined) return false;
        pending_paste_history_ref.current = {
            before: appended.before,
            rowIds: new Set(appended.rowIds),
        };
        const admitted_ids = new Set(appended.rowIds);
        const admitted_pending_topology_key = pending_topology_signature_for_rows(
            [
                ...appended.before.appendedRows.map((row) => row.id),
                ...appended.rowIds,
            ],
            appended.before.tailRemovals,
            tail_removal_projection_key,
        );
        const admitted_topology_key = [
            mapping_generation,
            column_projection.visible_to_source.join(','),
            admitted_pending_topology_key,
        ].join(':');
        return new Promise((resolve) => {
            let attempts = 0;
            const rollback = () => {
                pending_paste_history_ref.current = null;
                pending_store.remove_rows(edit_session_id, admitted_ids);
            };
            const poll = () => {
                // Only the rows admitted by this paste may distinguish the
                // post-admission topology from the topology DataEditor vetted.
                // Building this token from a later live snapshot would bless an
                // unrelated removal/cancellation that happened while React was
                // projecting the newly appended rows.
                const store_topology_key = pending_topology_signature(
                    pending_store.snapshot(),
                    tail_removal_projection_key,
                );
                const rendered_topology_key = paste_topology_key_ref.current;
                if (
                    store_topology_key !== admitted_pending_topology_key
                    || (
                        rendered_topology_key !== expected_topology_key
                        && rendered_topology_key !== admitted_topology_key
                    )
                ) {
                    rollback();
                    resolve(false);
                    return;
                }
                if (
                    rendered_topology_key === admitted_topology_key
                    && appended.rowIds.every((pendingRowId) =>
                        pending_projection_ref.current.display_row_for_identity({
                            kind: 'pending',
                            pendingRowId,
                        }) !== undefined)) {
                    let rolled_back = false;
                    resolve({
                        topologyKey: admitted_topology_key,
                        rollback: () => {
                            if (rolled_back) return;
                            rolled_back = true;
                            rollback();
                        },
                    });
                    return;
                }
                attempts += 1;
                if (attempts >= 120) {
                    rollback();
                    resolve(false);
                    return;
                }
                window.requestAnimationFrame(poll);
            };
            poll();
        });
    }, [
        admit_pending_rows,
        column_projection.visible_to_source,
        edit_session_id,
        mapping_generation,
        pending_store,
        tail_removal_projection_key,
    ]);
    /**
     * Stage `count` blank rows as one gesture, then put the caret in the first
     * editable cell of the first of them. Selecting the cell is what scrolls
     * the pending band into view — `select_active_display_cell` calls
     * `scrollTo` — so quick add and the in-grid append paths land the user in
     * the same place.
     */
    const append_and_focus_rows = useCallback(async (
        count: number,
        display_column: number,
    ): Promise<boolean> => {
        const appended = await admit_pending_rows(count);
        if (appended === undefined) return false;
        const pending_id = appended.rowIds[0];
        const display_row = await pending_display_row(pending_id);
        if (display_row === undefined) return false;
        select_active_display_cell_ref.current([display_column, display_row]);
        focus_grid_ref.current();
        return true;
    }, [admit_pending_rows, pending_display_row]);
    const append_and_focus = useCallback(
        (display_column: number): Promise<boolean> =>
            append_and_focus_rows(1, display_column),
        [append_and_focus_rows],
    );
    /**
     * Quick add. The first editable cell of a new row is display column 0 —
     * appended rows carry no per-cell editability of their own, and column 0 is
     * the leftmost visible column under whatever projection is installed.
     */
    const add_rows_from_dock = useCallback(
        (count: number): Promise<boolean> => append_and_focus_rows(count, 0),
        [append_and_focus_rows],
    );
    /**
     * The composer's staging path — quick add's sibling, with cell values.
     *
     * It appends through the same `admit_pending_rows` (there is exactly one
     * append path) with history suppressed, seeds the composed values, and
     * records a single gesture spanning both. Suppressing and re-recording is
     * what keeps one staging gesture at one history entry: an append entry
     * followed by an edit entry would take two undos to unwind what the user
     * did once.
     *
     * Values are built the way `commit_pending_live_edit` builds them, so a
     * field starting with `=` stages exactly as that text typed into a cell —
     * there is no formula path of the composer's own.
     */
    const stage_composed_rows = useCallback(async (
        rows: readonly (readonly string[])[],
    ): Promise<boolean> => {
        if (rows.length === 0) return false;
        const appended = await admit_pending_rows(rows.length, false);
        if (appended === undefined) return false;
        const edits: {
            readonly pendingRowId: string;
            readonly sourceColumn: number;
            readonly cell: PendingRowCell | undefined;
        }[] = [];
        rows.forEach((values, row_index) => {
            const pending_row_id = appended.rowIds[row_index];
            if (pending_row_id === undefined) return;
            values.forEach((raw, display_column) => {
                const source_column = visible_source_columns[display_column];
                if (source_column === undefined) return;
                const parsed = parse_cell_edit(raw, edit_syntax);
                // A blank field is not an edit: appended rows start empty, so
                // writing `undefined` would only churn the envelope.
                if (parsed.text === '' && parsed.rich === undefined) return;
                edits.push({
                    pendingRowId: pending_row_id,
                    sourceColumn: source_column,
                    cell: {
                        value: parsed.text,
                        ...(parsed.rich === undefined ? {} : { valueRuns: parsed.rich }),
                        valueEditOrder: issue_value_edit_order(),
                        ...(edit_syntax === 'markdown'
                            && formula_reference_bases !== undefined
                            && xlsx_edit_writes_formula(parsed.text, parsed.rich?.runs)
                            ? { formulaReferenceBases: formula_reference_bases(parsed.text) }
                            : {}),
                    },
                });
            });
        });
        if (edits.length > 0 && !pending_store.set_cells(edit_session_id, edits)) {
            // The rows themselves are staged and stay staged; only the values
            // were refused, so the gesture below still has something to record.
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'The composed values are too large to keep as pending changes.',
            });
        }
        record_pending_row_gesture(
            rows.length === 1 ? 'Compose row' : `Compose ${rows.length} rows`,
            appended.before,
            pending_store.snapshot(),
        );
        const display_row = await pending_display_row(appended.rowIds[0]);
        if (display_row === undefined) return true;
        select_active_display_cell_ref.current([0, display_row]);
        focus_grid_ref.current();
        return true;
    }, [
        admit_pending_rows,
        edit_session_id,
        edit_syntax,
        formula_reference_bases,
        issue_value_edit_order,
        pending_display_row,
        pending_store,
        record_pending_row_gesture,
        visible_source_columns,
    ]);
    const [composer_draft, set_composer_draft] = useState<AppendComposerDraft>(
        EMPTY_APPEND_COMPOSER_DRAFT,
    );
    // Which append surface is showing. The shell owns it because the dock has
    // to stand its quick-add controls down while the composer is up.
    const [composer_open, set_composer_open] = useState(false);
    /**
     * Labels for the composer's fields — the same titles the grid header
     * paints, so a field is identifiable by the column the user can see.
     */
    const composer_column_labels = useMemo(
        () => columns.map((column) => column.title),
        [columns],
    );
    const may_append_rows_ref = useRef(may_append_rows);
    may_append_rows_ref.current = may_append_rows;
    const append_and_focus_ref = useRef(append_and_focus);
    append_and_focus_ref.current = append_and_focus;
    const allow_rectangular_paste = useCallback((
        target: Item,
        values: readonly (readonly string[])[],
    ): boolean => {
        const width = values.reduce((max, row) => Math.max(max, row.length), 0);
        if (target[0] < 0 || target[0] + width > display_column_count) {
            host_bridge.postMessage({
                type: 'showWarning',
                message: 'The pasted range is wider than the visible worksheet columns.',
            });
            return false;
        }
        return true;
    }, [display_column_count]);

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
        source_column: number;
        edit_session_id: string | undefined;
        pin: symbol;
        opened_value?: string;
    } | null>(null);
    // Remains raised while an overlay lifetime is revoked, then clears when
    // editing reopens or a newly mounted tracking editor captures admission.
    // This closes the small window in which an already-queued finish can arrive
    // after the old editor was unmounted.
    const overlay_admission_revoked_ref = useRef(false);
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
    const source_column_for_display_ref = useRef(source_column_for_display);
    source_column_for_display_ref.current = source_column_for_display;

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
        const projected = pending_projection_ref.current.row_at(display_row);
        const source_row = projected?.kind === 'source'
            ? projected.identity?.sourceRow
                ?? get_source_row(projected.sourceDisplayRow)
            : undefined;
        const loader_row = projected?.kind === 'source'
            ? projected.sourceDisplayRow
            : display_row;
        const source_column = source_column_for_display_ref.current(loc[0]);
        // Unresolved identity: nothing to remember and nothing worth pinning. The
        // overlay-open gate means this is unreachable for a real editor mount, and
        // leaving the ref null keeps the commit guards' early return intact.
        if (source_row === undefined || source_column === undefined) return;
        overlay_admission_revoked_ref.current = false;
        open_overlay_row_ref.current = {
            display_cell: [loc[0], display_row],
            source_row,
            source_column,
            edit_session_id: edit_session_id_ref.current,
            pin: pin_rows_ref.current(loader_row, loader_row),
        };
    }, [release_open_overlay_row]);

    /**
     * Canonical source row for a current gesture. Live residency is the truth for
     * paste/fill/delete, which do not belong to an open overlay. If the row has
     * just been evicted, the overlay capture remains a safe fallback for its own
     * display row. Exact overlay edits choose the full captured identity at their
     * call sites so a newly resident row cannot steal a late finish.
     */
    const commit_source_row = useCallback((row: number): number | undefined => {
        const projected = pending_projection.row_at(row);
        const resident = projected?.kind === 'source'
            ? projected.identity?.sourceRow
                ?? get_source_row(projected.sourceDisplayRow)
            : get_source_row(row);
        if (resident !== undefined) return resident;
        const captured = open_overlay_row_ref.current;
        return captured !== null && captured.display_cell[1] === row
            ? captured.source_row
            : undefined;
    }, [get_source_row, pending_projection]);

    // Leaving edit mode (or a save taking the grid read-only) makes provide_editor
    // stop supplying an editor, which unmounts it and runs the cleanup below — but
    // only if Glide re-renders the overlay. Releasing here too makes the lifecycle
    // independent of that: an unreleased pin would hold a page resident for the
    // rest of the session.
    useLayoutEffect(() => {
        if (editable_cells) {
            // The revoked overlay was synchronously dismissed below. Reopening
            // admission permits the next ordinary edit callback; a real overlay
            // mount will replace the capture before it can finish in any case.
            overlay_admission_revoked_ref.current = false;
            return;
        }
        pending_editor_navigation_ref.current = null;
        overlay_admission_revoked_ref.current = true;
        // `provideEditor` controls whether a *new* overlay may open; Glide does
        // not consistently apply that change to one it already owns. The caller
        // initiating an ordinary transition folds the live text first. This
        // imperative dismissal is the final lifecycle boundary for revocation
        // and other transitions where accepting a late edit would be unsafe.
        grid_ref.current?.dismissOverlay();
        release_open_overlay_row();
    }, [editable_cells, release_open_overlay_row]);

    const previous_overlay_session_ref = useRef(edit_session_id);
    useLayoutEffect(() => {
        if (previous_overlay_session_ref.current === edit_session_id) return;
        previous_overlay_session_ref.current = edit_session_id;
        pending_editor_navigation_ref.current = null;
        overlay_admission_revoked_ref.current = true;
        grid_ref.current?.dismissOverlay();
        release_open_overlay_row();
    }, [edit_session_id, release_open_overlay_row]);

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
        const captured = open_overlay_row_ref.current;
        const captured_matches = captured !== null
            && captured.display_cell[0] === display_column
            && captured.display_cell[1] === row;
        const source_column = captured_matches
            ? captured.source_column
            : source_column_for_display(display_column);
        if (source_column === undefined) return null;
        const projected_row = pending_projection.row_at(row);
        if (
            projected_row?.kind === 'pending'
            || projected_row?.kind === 'replacement'
        ) {
            const rendered = pending_rendered_rows
                .get(projected_row.row.id)?.[source_column];
            let original = rendered === null || rendered === undefined
                ? ''
                : cell_edit_text(rendered, edit_syntax);
            if (rendered?.formula !== undefined) {
                original = formula_move_retargeter?.(
                    rendered.formula,
                    sheet_index,
                    projected_row.row.cells[source_column]?.valueEditOrder ?? 0,
                ) ?? rendered.formula;
            }
            return {
                kind: 'pending',
                pendingRowId: projected_row.row.id,
                sourceColumn: source_column,
                value,
                original,
            };
        }
        // The `key` is a durable edit key, so it must be fully source-keyed: the
        // save collectors (collect_save_payload) merge it
        // straight into the source-keyed dirty map, and a display-keyed LiveEdit
        // would poison them. Falls back to the identity captured when this overlay
        // opened, so an editor whose page left mid-edit still reaches the save
        // rather than being silently dropped (see commit_source_row).
        const source_row = captured_matches
            ? captured.source_row
            : commit_source_row(row);
        if (source_row === undefined) return null;
        // `original` is what the editor *opened with*, so cleanliness is a
        // comparison in the editor's own space. On a markdown sheet that is
        // the cell's markup (mirroring get_cell_content's `edit_value`), not
        // the plain raw text — comparing "**x**" against "x" would mark an
        // untouched bold cell as uncommitted the moment its editor opened.
        const key = cell_key(source_row, source_column);
        let original: string;
        const dirty = store.get(key);
        if (dirty) {
            original = dirty_value_edit_text(dirty, edit_syntax);
            if (xlsx_edit_writes_formula(dirty.value, dirty.valueRuns?.runs)) {
                original = formula_move_retargeter?.(
                    original,
                    sheet_index,
                    dirty.valueEditOrder ?? 0,
                ) ?? original;
            }
        } else if (edit_syntax === 'markdown') {
            const cell = get_cell_for_source_ref.current(source_row, source_column);
            original = cell?.formula !== undefined
                ? formula_move_retargeter?.(cell.formula, sheet_index) ?? cell.formula
                : cell
                    ? cell_edit_text(cell, edit_syntax)
                : get_cell_raw(source_row, source_column) ?? '';
        } else {
            original = get_cell_raw(source_row, source_column) ?? '';
        }
        return { kind: 'source', key, value, original };
    }, [
        commit_source_row,
        edit_syntax,
        formula_move_retargeter,
        get_cell_raw,
        pending_projection,
        pending_rendered_rows,
        sheet_index,
        source_column_for_display,
        store,
    ]);

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

    const planned_live_height_ref = useRef<(
        live: LiveEdit,
    ) => { readonly displayRow: number; readonly height: number } | undefined>(() => undefined);
    const grow_committed_source_live_ref = useRef<(live: LiveEdit) => void>(() => {});

    const commit_live_value = useCallback((live: LiveEdit): boolean => {
        const refusal_before = envelope_refusal_sequence_ref.current;
        const refused = (): false => {
            if (envelope_refusal_sequence_ref.current !== refusal_before) {
                show_pending_size_warning();
            }
            return false;
        };
        if (live.kind === 'source') {
            const [source_row, source_column] = live.key.split(':').map(Number);
            if (Number.isInteger(source_row) && Number.isInteger(source_column)) {
                const pending_before = pending_store.snapshot();
                const conflict_staging = pending_store.stage_clear_formula_conflicts(
                    edit_session_id,
                    [{
                        rowIdentity: { kind: 'source', sourceRow: source_row },
                        sourceColumn: source_column,
                    }],
                );
                const history_changes = conflict_staging === undefined
                    ? []
                    : pending_row_history_changes(
                        history_capture?.worksheet ?? {
                            sheetIndex: sheet_index,
                            ...(sheet_meta.name === undefined
                                ? {}
                                : { sheetName: sheet_meta.name }),
                            ...(sheet_meta.worksheetId === undefined
                                ? {}
                                : { worksheetId: sheet_meta.worksheetId }),
                        },
                        pending_before,
                        conflict_staging.next,
                    );
                if (commit_edit(
                    source_row,
                    source_column,
                    live.value,
                    live.original,
                    history_changes,
                    conflict_staging === undefined ? [] : [conflict_staging.mutation],
                )) {
                    grow_committed_source_live_ref.current(live);
                    return true;
                }
            }
            return refused();
        }
        const parsed = parse_cell_edit(live.value, edit_syntax);
        const before = pending_store.snapshot();
        const current = before.appendedRows.find(
            (row) => row.id === live.pendingRowId,
        )?.cells[live.sourceColumn];
        const cell: PendingRowCell | undefined = parsed.text === ''
            && parsed.rich === undefined
            && current?.link == null
            ? undefined
            : {
                value: parsed.text,
                ...(parsed.rich === undefined ? {} : { valueRuns: parsed.rich }),
                ...(current?.link === undefined ? {} : { link: current.link }),
                valueEditOrder: issue_value_edit_order(),
                ...(edit_syntax === 'markdown'
                    && formula_reference_bases !== undefined
                    && xlsx_edit_writes_formula(parsed.text, parsed.rich?.runs)
                    ? { formulaReferenceBases: formula_reference_bases(parsed.text) }
                    : {}),
            };
        const planned_height = planned_live_height_ref.current(live);
        const row_heights = planned_height === undefined
            ? new Map<string, number>()
            : new Map([[live.pendingRowId, planned_height.height]]);
        if (pending_store.set_cells(
            edit_session_id,
            [{
                pendingRowId: live.pendingRowId,
                sourceColumn: live.sourceColumn,
                cell,
            }],
            row_heights,
        )) {
            record_pending_row_gesture('Edit cell', before, pending_store.snapshot());
            return true;
        }
        return refused();
    }, [
        commit_edit,
        edit_session_id,
        edit_syntax,
        formula_reference_bases,
        history_capture,
        issue_value_edit_order,
        pending_store,
        record_pending_row_gesture,
        sheet_index,
        sheet_meta.name,
        sheet_meta.worksheetId,
        show_pending_size_warning,
    ]);

    // Fold this sheet's live editor, then let App snapshot every dirty worksheet
    // and post one atomic workbook operation. GridShell never assembles a partial
    // operation: the registry and operation identity both live above this mount.
    const request_save = useCallback((): boolean => {
        if (edit_admission_is_fenced() || save_in_flight_ref.current || !edit_session_id) {
            return false;
        }
        if (gestures_admitted !== undefined && !gestures_admitted()) return false;
        // The hyperlink editor owns its draft state. Fold a valid draft into the
        // shared store before App snapshots every worksheet; an invalid draft
        // remains visible and blocks the save instead of being silently lost.
        if (
            hyperlink_dialog_ref.current
            && !hyperlink_dialog_ref.current.commit()
        ) return false;
        const live = read_live_edit();
        if (live && live.value !== live.original) {
            if (!commit_live_value(live)) return false;
        }
        const operation = on_save_request();
        if (
            !operation
            || operation.editSessionId !== edit_session_id
            || operation.saveRequestId.length === 0
        ) return false;
        grid_ref.current?.dismissOverlay();
        const worksheet = worksheet_payload(operation);
        save_operation_ref.current = operation;
        saved_edits_ref.current = worksheet ? { ...worksheet.edits } : {};
        save_in_flight_ref.current = true;
        set_save_in_flight(true);
        set_live_uncommitted(false);
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        return true;
    }, [
        commit_live_value,
        edit_admission_is_fenced,
        edit_session_id,
        gestures_admitted,
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
     * function rather than a branch inside `on_cells_edited`. There are two such paths and
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
     * display→source mapper. The auto-grow comment in `on_cells_edited` has the full
     * version of that argument.
     */
    const structural_row_height = useCallback((row: number): number | undefined => {
        const projected = pending_projection.row_at(row);
        if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
            const format = pending_template_formats.get(projected.row.formatTemplateId);
            return projected.row.viewerRowHeight
                ?? (format?.kind === 'xlsx'
                    ? format.viewerRowHeight
                        ?? (format.nativeRowHeight === undefined
                            ? undefined
                            : format.nativeRowHeight * 96 / 72)
                    : undefined);
        }
        if (projected?.kind === 'removal') {
            return projected.removal.savedRow.viewerRowHeight
                ?? (projected.removal.savedRow.format.kind === 'xlsx'
                    && projected.removal.savedRow.format.nativeRowHeight !== undefined
                    ? projected.removal.savedRow.format.nativeRowHeight * 96 / 72
                    : undefined);
        }
        return undefined;
    }, [pending_payload_revision, pending_projection, pending_template_formats]);
    const effective_row_height = useCallback((
        row: number,
        include_preview = true,
    ): number => {
        if (
            include_preview
            && row_resize_preview
            && (
                row_resize_preview.row === row
                || row_resize_preview.preview_rows?.hasIndex(row)
            )
        ) return row_resize_preview.height;
        const projected = pending_projection.row_at(row);
        const height_row = projected?.kind === 'source'
            ? projected.sourceDisplayRow
            : row;
        return structural_row_height(row) ?? resolved_row_height(
            row_heights,
            row_height_overlay,
            height_row,
            default_row_height,
        );
    }, [
        default_row_height,
        row_heights,
        row_height_overlay,
        pending_projection,
        row_resize_preview,
        structural_row_height,
    ]);

    const planned_auto_grow_height = useCallback((
        display_row: number,
        text: string,
        display_column?: number,
    ): number | undefined => {
        // A fast path, and said so rather than dressed up as the gate: probed by deleting
        // it, and nothing failed, because `natural_row_height` floors at the default so an
        // ordinary one-line value measures *exactly* the default and the comparison below
        // refuses it anyway. The pair is what makes "a single-line commit resizes nothing"
        // true, and that claim is pinned by removing both. Kept because it is the cheaper
        // of the two and because it says what this affordance is for: hard line breaks, not
        // text length.
        if (!has_line_break(text)) return undefined;
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
        // A vertical merge paints its content across every row of the block, so the
        // height that has to fit the text is the block's total, not the anchor row's.
        // Comparing (and growing) only the anchor would inflate a block that is
        // already tall enough. Merges are only supplied under an identity view, so
        // the display coordinates here index merge_index's source space directly;
        // with merges withheld the index is empty and this is the plain single row.
        const entry = display_column === undefined
            ? null
            : merge_index.is_anchor(display_row, display_column);
        let available = 0;
        const last_row = entry ? entry.endRow : display_row;
        for (let r = display_row; r <= last_row; r++) {
            available += effective_row_height(r, false);
        }
        // `<=`, so a row already at the needed height posts nothing. That is not a
        // micro-optimization: `natural_row_height` floors at the default, so an ordinary
        // one-line value measures *exactly* the default and a `<` here would post a resize
        // for every edit commit — which is a durable write and a delivery each time. It is
        // also the second half of the guard against the unbounded case above, where the
        // clamped `needed` and the stored height meet at the ceiling.
        if (needed <= available) return undefined;
        // Grow only the anchor row, by the block's deficit: the covered rows keep
        // their heights and the block's total lands exactly at `needed`.
        const anchor_height = effective_row_height(display_row, false);
        return clamp_row_height(anchor_height + (needed - available));
    }, [
        default_row_height,
        effective_row_height,
        font_size_px,
        merge_index,
    ]);
    const auto_grow_row_for_text = useCallback((
        display_row: number,
        text: string,
        display_column?: number,
        record_history = true,
    ): boolean => {
        const height = planned_auto_grow_height(display_row, text, display_column);
        if (height === undefined) return false;
        apply_row_resize(
            [{ start: display_row, end: display_row }],
            height,
            record_history,
        );
        return true;
    }, [
        apply_row_resize,
        planned_auto_grow_height,
    ]);
    planned_live_height_ref.current = (live) => {
        const active_cell = grid_selection_ref.current.current?.cell;
        if (active_cell === undefined) return undefined;
        const [display_column, display_row] = active_cell;
        const projected = pending_projection.row_at(display_row);
        const same_cell = live.kind === 'pending'
            ? (projected?.kind === 'pending' || projected?.kind === 'replacement')
                && projected.row.id === live.pendingRowId
                && source_column_for_display(display_column) === live.sourceColumn
            : projected?.kind === 'source'
                && `${projected.identity?.sourceRow
                    ?? get_source_row(projected.sourceDisplayRow)}:${
                    source_column_for_display(display_column)}`
                    === live.key;
        if (!same_cell) return undefined;
        const height = planned_auto_grow_height(display_row, live.value, display_column);
        return height === undefined ? undefined : { displayRow: display_row, height };
    };
    grow_committed_source_live_ref.current = (live) => {
        const planned = planned_live_height_ref.current(live);
        if (planned === undefined) return;
        auto_grow_row_for_text(
            planned.displayRow,
            live.value,
            grid_selection_ref.current.current?.cell?.[0],
        );
    };

    const commit_live_edit_unfenced = useCallback((): boolean => {
        if (save_in_flight_ref.current) {
            grid_ref.current?.dismissOverlay();
            return true;
        }
        const live = read_live_edit();
        if (live && live.value !== live.original) {
            if (!commit_live_value(live)) return false;
        }
        set_live_uncommitted(false);
        // Folding and terminating are one lifecycle operation. Merely changing
        // provideEditor or the controlled selection can leave Glide's portalled
        // overlay mounted, which is how a cell from the newly selected sheet
        // appeared as a dialog after a highlight transition.
        grid_ref.current?.dismissOverlay();
        return true;
    }, [
        auto_grow_row_for_text,
        commit_live_value,
        read_live_edit,
        save_in_flight_ref,
    ]);

    const commit_live_edit = useCallback((): boolean => {
        if (edit_admission_is_fenced()) return false;
        return commit_live_edit_unfenced();
    }, [commit_live_edit_unfenced, edit_admission_is_fenced]);

    const commit_live_edit_at_close_barrier = useCallback((): boolean => {
        if (!edit_admission_is_fenced()) return false;
        if (close_barrier_folded_activation_ref.current === edit_activation_id) return true;
        close_barrier_folded_activation_ref.current = edit_activation_id;
        return commit_live_edit_unfenced();
    }, [commit_live_edit_unfenced, edit_activation_id, edit_admission_is_fenced]);

    const flush_live_edit = useCallback((): boolean => {
        if (edit_admission_is_fenced() || !commit_live_edit_unfenced()) return false;
        const snapshot = store.snapshot();
        post_pending_edits(
            snapshot.size > 0 ? Object.fromEntries(snapshot) : null,
        );
        return true;
    }, [commit_live_edit_unfenced, edit_admission_is_fenced, post_pending_edits, store]);

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
        if (edit_admission_is_fenced() || save_in_flight_ref.current) return;
        clear_dirty();
    }, [clear_dirty, edit_admission_is_fenced, save_in_flight_ref]);
    const guarded_discard_conflicted = useCallback(() => {
        if (edit_admission_is_fenced() || save_in_flight_ref.current) return;
        discard_conflicted();
    }, [discard_conflicted, edit_admission_is_fenced, save_in_flight_ref]);
    const guarded_discard_keys = useCallback((keys: readonly string[]) => {
        if (edit_admission_is_fenced() || save_in_flight_ref.current) return;
        if (keys.length === 0) return;
        // Host-named keys are already source-keyed, so they go straight into the
        // source-keyed store with no conversion — the payoff for having moved
        // durable identity to the source row first.
        clear_dirty_keys(new Set(keys));
    }, [clear_dirty_keys, edit_admission_is_fenced, save_in_flight_ref]);

    // Expose the imperative actions to App through the ref it provides.
    useEffect(() => {
        if (!editing_ref) return;
        editing_ref.current = {
            request_save,
            clear_dirty: guarded_clear_dirty,
            discard_conflicted: guarded_discard_conflicted,
            discard_keys: guarded_discard_keys,
            can_reveal_source_cell,
            reveal_source_cell,
            reveal_pending_row,
            remove_pending_rows,
            reveal_tail_removal,
            cancel_tail_removals,
            stop_edit_admission() {
                fenced_edit_activation_ref.current = edit_activation_id;
                set_fenced_edit_activation(edit_activation_id);
            },
            commit_live_edit,
            commit_live_edit_at_close_barrier,
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
        can_reveal_source_cell,
        reveal_source_cell,
        reveal_pending_row,
        remove_pending_rows,
        reveal_tail_removal,
        cancel_tail_removals,
        edit_activation_id,
        commit_live_edit,
        commit_live_edit_at_close_barrier,
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

    const get_row_height = useMemo(() => {
        // Glide walks the visible rows once per column and getCellContent runs for
        // every cell. Keep row-height layer searches at roughly once per row, as
        // row-heights.ts budgets, without retaining an unbounded sheet-sized map.
        const cache = new Map<number, number>();
        return (row: number): number => {
            const cached = cache.get(row);
            if (cached !== undefined) return cached;
            const height = effective_row_height(row);
            // A 512-row viewport is already over 12,000px at the minimum row
            // height. Clear rather than let non-paint consumers grow this forever.
            if (cache.size >= 512) cache.clear();
            cache.set(row, height);
            return height;
        };
    }, [
        effective_row_height,
    ]);

    const get_cell_height = useCallback((row: number, display_column: number): number => {
        // Glide requests a merged block at its anchor coordinates, but paints it
        // across every covered row. Its effective height is therefore the sum of
        // the span, not merely the anchor row's height.
        const entry = merge_index.is_anchor(row, display_column);
        const last_row = entry?.endRow ?? row;
        let height = 0;
        for (let r = row; r <= last_row; r++) height += get_row_height(r);
        return height;
    }, [get_row_height, merge_index]);

    const get_cell_width = useCallback((row: number, display_column: number): number => {
        // The renderer paints in logical canvas pixels. Hover bounds are scaled
        // client pixels (and include Glide's one-pixel hit-test border), so they
        // cannot be compared directly with canvas measureText widths. Sum the
        // same displayed-column widths the renderer uses, including a horizontal
        // merge's full span.
        const entry = merge_index.is_anchor(row, display_column);
        const last_column = entry?.endCol ?? display_column;
        let width = 0;
        for (let column = display_column; column <= last_column; column++) {
            const grid_column = columns[column];
            if (grid_column && 'width' in grid_column) width += grid_column.width;
        }
        return width;
    }, [columns, merge_index]);

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
    // Whether the link-open modifier (Cmd on macOS, Ctrl elsewhere) is held.
    // Drives the linked-cell cursor: a plain click selects, so the pointer
    // cursor appears only while Ctrl/Cmd+click would actually open the link.
    // Reset on window blur — the keyup is lost when e.g. Cmd+Tab switches away.
    const [link_modifier_held, set_link_modifier_held] = useState(false);
    useEffect(() => {
        const update = (e: KeyboardEvent) => set_link_modifier_held(e.metaKey || e.ctrlKey);
        const reset = () => set_link_modifier_held(false);
        window.addEventListener('keydown', update);
        window.addEventListener('keyup', update);
        window.addEventListener('blur', reset);
        return () => {
            window.removeEventListener('keydown', update);
            window.removeEventListener('keyup', update);
            window.removeEventListener('blur', reset);
        };
    }, []);
    const cell_tooltip_timer_ref = useRef<number | null>(null);
    const cell_tooltip_el_ref = useRef<HTMLDivElement | null>(null);
    const cell_tooltip_key_ref = useRef<string | null>(null);
    const cell_tooltip_hover_ref = useRef<{
        displayColumn: number;
        row: number;
        bounds: { x: number; y: number; width: number; height: number };
    } | null>(null);

    const clear_cell_tooltip_timer = useCallback(() => {
        if (cell_tooltip_timer_ref.current !== null) {
            window.clearTimeout(cell_tooltip_timer_ref.current);
            cell_tooltip_timer_ref.current = null;
        }
    }, []);

    const hide_cell_tooltip = useCallback(() => {
        clear_cell_tooltip_timer();
        cell_tooltip_key_ref.current = null;
        cell_tooltip_hover_ref.current = null;
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
            const projected_row = pending_projection.row_at(row);
            if (projected_row !== undefined && projected_row.kind !== 'source') {
                const rendered_row = projected_row.kind === 'removal'
                    ? removal_rendered_rows.get(projected_row.removal.sourceRow)
                    : pending_rendered_rows.get(projected_row.row.id);
                return displayed_text(rendered_row?.[source_column], show_formatting, undefined);
            }
            // Source-keyed dirty lookup. When the source row is unresolved there
            // can be no edit to show, so fall through to the persisted-cell path
            // below (which reads the same non-resident row and yields '').
            const source_display_row = projected_row?.kind === 'source'
                ? projected_row.sourceDisplayRow
                : row;
            const source_row = projected_row?.kind === 'source'
                ? projected_row.identity?.sourceRow
                : get_source_row(source_display_row);
            const key = source_row === undefined
                ? undefined
                : cell_key(source_row, source_column);
            const dirty = key === undefined ? undefined : store.get(key);

            // Merged blocks need no special case: the grid's hover hit-test
            // reports the anchor's coordinates for any covered cell, so this is
            // already the cell that holds the content.
            const cells = get_row(source_display_row);
            const cell = cells?.[source_column];
            const overlay = source_row === undefined || key === undefined
                ? undefined
                : value_overlay_for_cell(source_row, source_column, key, cell, dirty);
            return displayed_text(cell, show_formatting, overlay);
        },
        [
            get_row,
            get_source_row,
            pending_projection,
            pending_rendered_rows,
            pending_tail_removal_source_rows,
            removal_rendered_rows,
            show_formatting,
            source_column_for_display,
            store,
            value_overlay_for_cell,
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

    /** The cell's *effective* hyperlink at display coordinates: a pending link
     *  edit if one exists, otherwise the loaded cell's own link. Everything
     *  link-aware (tooltip, Ctrl/Cmd+click, the menu items, the dialog's
     *  initial value) reads through here, so an uncommitted link edit behaves
     *  exactly like a saved one. Merged blocks arrive as anchor coordinates
     *  (Glide canonicalizes the hit), which is where the content — and the
     *  link — lives. */
    const cell_hyperlink = useCallback(
        (display_column: number, row: number): CellHyperlink | undefined => {
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) return undefined;
            const projected = pending_projection.row_at(row);
            if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
                return projected.row.cells[source_column]?.link ?? undefined;
            }
            if (projected?.kind === 'removal') {
                return projected.removal.savedRow.cells[source_column]?.link ?? undefined;
            }
            const source_display_row = projected?.kind === 'source'
                ? projected.sourceDisplayRow
                : row;
            const source_row = projected?.kind === 'source'
                ? projected.identity?.sourceRow
                    ?? get_source_row(source_display_row)
                : get_source_row(source_display_row);
            if (source_row !== undefined) {
                // `link: null` is a pending *clear* — a real answer, not a miss.
                const pending = store.get(cell_key(source_row, source_column))?.link;
                if (pending !== undefined) return pending ?? undefined;
            }
            return get_row(source_display_row)?.[source_column]?.hyperlink;
        },
        [get_row, get_source_row, pending_projection, source_column_for_display, store],
    );

    const font_flags_for_cell = useCallback(
        (display_column: number, row: number): { bold: boolean; italic: boolean } => {
            const source_column = source_column_for_display(display_column);
            if (source_column === undefined) return { bold: false, italic: false };
            const projected = pending_projection.row_at(row);
            if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
                const format = pending_template_formats.get(projected.row.formatTemplateId);
                const flags = format?.kind === 'xlsx'
                    ? format.cellFontStyles?.[source_column]
                    : undefined;
                return { bold: !!flags?.bold, italic: !!flags?.italic };
            }
            if (projected?.kind === 'removal') {
                const format = projected.removal.savedRow.format;
                const flags = format.kind === 'xlsx'
                    ? format.cellFontStyles?.[source_column]
                    : undefined;
                return { bold: !!flags?.bold, italic: !!flags?.italic };
            }
            // Merged blocks arrive here as anchor coordinates (the grid's
            // hit-test snaps covered cells), which is where the content lives.
            const source_display_row = projected?.kind === 'source'
                ? projected.sourceDisplayRow
                : row;
            const cell = get_row(source_display_row)?.[source_column];
            return {
                bold: !!cell?.bold,
                italic: !!cell?.italic,
            };
        },
        [
            get_row,
            pending_projection,
            pending_template_formats,
            source_column_for_display,
        ],
    );

    const schedule_cell_tooltip = useCallback(
        (
            display_column: number,
            row: number,
            cell_bounds: { x: number; y: number; width: number; height: number },
        ) => {
            cell_tooltip_hover_ref.current = {
                displayColumn: display_column,
                row,
                bounds: cell_bounds,
            };
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
            const link = cell_hyperlink(display_column, row);
            if (!text && !link) return;

            const source_column = source_column_for_display(display_column);
            const projected_row = pending_projection.row_at(row);
            const source_display_row = projected_row?.kind === 'source'
                ? projected_row.sourceDisplayRow
                : row;
            const source_row = projected_row?.kind === 'source'
                ? projected_row.identity?.sourceRow
                    ?? get_source_row(source_display_row)
                : get_source_row(source_display_row);
            const source_key = source_row !== undefined && source_column !== undefined
                ? cell_key(source_row, source_column)
                : undefined;
            const dirty = source_key === undefined ? undefined : store.get(source_key);
            const loaded = source_column === undefined
                ? null
                : get_row(source_display_row)?.[source_column] ?? null;
            // Hover bounds are client-space geometry. A fractional canvas scale
            // can make a default 24px row arrive as 24.5px, which must not turn
            // every single-line cell into a soft-wrapped cell. Read the same
            // logical (merge-aware) geometry used by build_grid_cell instead.
            const cell_height = get_cell_height(row, display_column);
            const cell_width = get_cell_width(row, display_column);
            const soft_wrap = auto_fit_active
                || cell_height > default_row_height;
            // Measure the same effective payload the grid paints. In particular,
            // a pending Markdown edit may introduce styled runs into a plain or
            // blank cell, and an empty dirty value must suppress persisted runs.
            const rich_data = rich_cell_display_data(
                loaded,
                show_formatting,
                font_size_px,
                source_row === undefined || source_column === undefined || source_key === undefined
                    ? undefined
                    : value_overlay_for_cell(
                        source_row,
                        source_column,
                        source_key,
                        loaded,
                        dirty,
                    ),
                soft_wrap,
                diff_colors,
            );

            let overflows: boolean;
            if (rich_data) {
                // Rich paint and hover measurement share both the run-aware
                // layout and the payload's effective wrapping decision.
                overflows = rich_text_overflows_cell(
                    rich_data.lines,
                    cell_width,
                    (segment, style) => measure_line_width(
                        segment,
                        style?.bold ?? false,
                        style?.italic ?? false,
                    ),
                    {
                        cell_height,
                        line_height: line_height_for_font(font_size_px),
                        wrapping: rich_data.allow_wrapping === true,
                    },
                );
            } else {
                const flags = font_flags_for_cell(display_column, row);
                // Use the same wrapping rule as build_grid_cell. `cell_bounds` is
                // client-space positioning only; logical height also includes a
                // vertical merge's rows without inheriting canvas scale noise.
                const wrapping = cell_allows_wrapping(text, soft_wrap);
                overflows = text !== '' && text_overflows_cell(
                    text,
                    cell_width,
                    (line) => measure_line_width(line, flags.bold, flags.italic),
                    {
                        cell_height,
                        line_height: line_height_for_font(font_size_px),
                        wrapping,
                    },
                );
            }
            const content = cell_tooltip_content(
                text,
                overflows,
                link,
                link_open_hint(browserIsOSX.value),
            );
            if (content === null) return;

            const clamped = clamp_tooltip_text(content);
            cell_tooltip_timer_ref.current = window.setTimeout(() => {
                cell_tooltip_timer_ref.current = null;
                // Drop if the pointer left this cell during the dwell.
                if (cell_tooltip_key_ref.current !== key) return;
                // Initial placement uses an estimated size; layout effect below
                // re-centers once the real tooltip box is measured.
                const estimated = {
                    width: Math.min(360, Math.max(80, clamped.length * 7)),
                    height: 28 + (count_lines(clamped) - 1) * 16,
                };
                const pos = cell_tooltip_position(cell_bounds, estimated);
                set_cell_tooltip({
                    text: clamped,
                    bounds: cell_bounds,
                    left: pos.left,
                    top: pos.top,
                });
            }, CELL_TOOLTIP_SHOW_DELAY_MS);
        },
        [
            clear_cell_tooltip_timer,
            auto_fit_active,
            displayed_cell_text,
            font_flags_for_cell,
            font_size_px,
            measure_line_width,
            default_row_height,
            cell_hyperlink,
            get_row,
            get_source_row,
            get_cell_height,
            get_cell_width,
            show_formatting,
            diff_colors,
            source_column_for_display,
            store,
            value_overlay_for_cell,
        ],
    );

    const tooltip_formula_state_ref = useRef({
        formulaResults: formula_results,
        pendingImpact: pending_formula_impact,
        sourceResults: source_formula_results,
    });
    useEffect(() => {
        const previous = tooltip_formula_state_ref.current;
        tooltip_formula_state_ref.current = {
            formulaResults: formula_results,
            pendingImpact: pending_formula_impact,
            sourceResults: source_formula_results,
        };
        if (
            previous.formulaResults === formula_results
            && previous.pendingImpact === pending_formula_impact
            && previous.sourceResults === source_formula_results
        ) return;
        const hovered = cell_tooltip_hover_ref.current;
        if (!hovered) return;
        // Formula state can settle without another pointer event. Force the
        // hovered cell through the same display/overflow path so a pending or
        // visible tooltip cannot retain text the canvas has already replaced.
        cell_tooltip_key_ref.current = null;
        schedule_cell_tooltip(hovered.displayColumn, hovered.row, hovered.bounds);
    }, [
        formula_results,
        pending_formula_impact,
        schedule_cell_tooltip,
        source_formula_results,
    ]);

    const schedule_header_tooltip = useCallback((
        display_column: number,
        bounds: { x: number; y: number; width: number; height: number },
    ) => {
        cell_tooltip_hover_ref.current = null;
        const source_column = source_column_for_display(display_column);
        if (
            sheet_meta.excelFirstRowHeader?.active !== true
            || source_column === undefined
        ) {
            hide_cell_tooltip();
            return;
        }
        const key = `header:${display_column}`;
        if (cell_tooltip_key_ref.current === key) return;

        clear_cell_tooltip_timer();
        cell_tooltip_key_ref.current = key;
        set_cell_tooltip(null);
        const text = `Excel column ${column_letter(source_column)}`;
        cell_tooltip_timer_ref.current = window.setTimeout(() => {
            cell_tooltip_timer_ref.current = null;
            if (cell_tooltip_key_ref.current !== key) return;
            const estimated = {
                width: Math.max(80, text.length * 7),
                height: 28,
            };
            const pos = cell_tooltip_position(bounds, estimated);
            set_cell_tooltip({
                text,
                bounds,
                left: pos.left,
                top: pos.top,
            });
        }, CELL_TOOLTIP_SHOW_DELAY_MS);
    }, [
        clear_cell_tooltip_timer,
        hide_cell_tooltip,
        sheet_meta.excelFirstRowHeader?.active,
        source_column_for_display,
    ]);

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

    useEffect(() => {
        if (version === 0 || !has_visible_columns) return;
        on_auto_fit_sample_change?.();
    }, [has_visible_columns, on_auto_fit_sample_change, version]);

    const get_highlight_background = useCallback((
        source_row: number,
        source_column: number,
    ): string | undefined => {
        const color = cell_highlights?.cells[cell_key(source_row, source_column)];
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
            const projected_row = pending_projection.row_at(row);
            if (projected_row !== undefined && projected_row.kind !== 'source') {
                const is_removal = projected_row.kind === 'removal';
                const pending_id = projected_row.kind === 'pending'
                    || projected_row.kind === 'replacement'
                    ? projected_row.row.id
                    : undefined;
                const rendered_row = projected_row.kind === 'removal'
                    ? removal_rendered_rows.get(projected_row.removal.sourceRow)
                    : pending_rendered_rows.get(projected_row.row.id);
                const rendered_cell = rendered_row?.[source_column];
                const replacement_base_cell = projected_row.kind === 'replacement'
                    ? removal_rendered_rows.get(
                        projected_row.removal.sourceRow,
                    )?.[source_column]
                    : undefined;
                const editable = editable_cells && !is_removal;
                const pending_highlight = projected_row.kind === 'pending'
                    || projected_row.kind === 'replacement'
                    ? projected_row.row.highlights?.[source_column]
                    : undefined;
                const pending_value_cell = projected_row.kind === 'pending'
                    || projected_row.kind === 'replacement'
                    ? projected_row.row.cells[source_column]
                    : undefined;
                const pending_formula = rendered_cell?.formula === undefined
                    ? undefined
                    : formula_move_retargeter?.(
                        rendered_cell.formula,
                        sheet_index,
                        pending_value_cell?.valueEditOrder ?? 0,
                    ) ?? rendered_cell.formula;
                const pending_formula_result = rendered_cell?.formula === undefined
                    ? undefined
                    : calculated_formula_display(
                        formula_results_ref.current?.get(
                            `${projected_row.intendedPhysicalRow}:${source_column}`,
                        ),
                        show_formatting,
                        rendered_cell,
                    );
                const overlay: CellEditOverlay = {
                    editable,
                    refused: editable_cells && is_removal,
                    bg: pending_highlight === undefined
                        ? is_removal ? compare_row_bgs.deleted : compare_row_bgs.added
                        : highlight_rgba(pending_highlight, high_contrast),
                    ...(edit_syntax === 'markdown' && editable && rendered_cell !== null
                        && rendered_cell !== undefined
                        ? {
                            edit_value: pending_formula
                                ?? cell_edit_text(rendered_cell, edit_syntax),
                        }
                        : {}),
                    ...(rendered_cell?.formula === undefined
                        ? {}
                        : pending_formula_result === undefined
                            ? { formula_result_pending: true as const }
                            : { formula_result: pending_formula_result }),
                    ...(is_removal ? { compare_deleted: true as const } : {}),
                    ...(diff_mode && projected_row.kind === 'replacement'
                        ? { diff_base: displayed_text(
                            replacement_base_cell ?? null,
                            show_formatting,
                            undefined,
                        ) }
                        : {}),
                };
                const grid_cell = build_grid_cell(
                    source_column,
                    rendered_row,
                    show_formatting,
                    overlay,
                    font_size_px,
                    get_cell_height(row, display_column) > default_row_height,
                    link_modifier_held,
                    diff_colors,
                );
                return pending_id === undefined ? grid_cell : {
                    ...grid_cell,
                    clipboardData: {
                        source: clipboard_source,
                        location: [source_column, projected_row.intendedPhysicalRow],
                        gridLocation: [display_column, row],
                        projectionGeneration: mapping_generation,
                        rowIdentity: projected_row.identity,
                        ...(pending_formula === undefined
                            ? {}
                            : { formula: pending_formula }),
                    },
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
            // No merge resolution is needed for content identity: the vendored
            // grid redirects a merged block's paint (and its hit-tests) to the
            // anchor's coordinates, so
            // this callback answers for the cell it was actually asked about —
            // the anchor's own content, highlight, and dirty state cover the
            // whole block.
            const source_display_row = projected_row?.kind === 'source'
                ? projected_row.sourceDisplayRow
                : row;
            const source_row = projected_row?.kind === 'source'
                ? projected_row.identity?.sourceRow
                    ?? get_source_row(source_display_row)
                : get_source_row(source_display_row);
            const key = source_row === undefined
                ? undefined
                : cell_key(source_row, source_column);
            const dirty = key === undefined ? undefined : store.get(key);
            const highlight_bg = source_row === undefined
                ? undefined
                : get_highlight_background(source_row, source_column);
            // Tint + dirty text whenever an edit exists; open the overlay only in
            // edit mode and only where source identity resolved. A resident blank
            // cell stays editable so blanks can still be typed.
            // dirty read through the stable `store` handle and conflict through
            // conflicted_keys_ref — never through the subscribed dirty_cells — so
            // this closure's identity doesn't churn per edit; the targeted repaint
            // effect damages the cells whose tint actually changed.
            const pending_removal = source_row !== undefined
                && pending_tail_removal_source_rows.has(source_row);
            const editable = editable_cells && source_row !== undefined && !pending_removal;
            const loaded_row = get_row(source_display_row);
            const loaded_cell = loaded_row?.[source_column];
            const value_overlay = source_row === undefined || key === undefined
                ? undefined
                : value_overlay_for_cell(
                    source_row,
                    source_column,
                    key,
                    loaded_cell,
                    dirty,
                );
            const dependent_formula_affected = dirty === undefined
                && value_overlay !== undefined;
            // On a markdown sheet the overlay editor must open with markup, not
            // the plain projection: a dirty cell re-opens showing its committed
            // runs, a clean cell its effective rich content. Only computed when
            // the cell can actually open an editor — this is Glide's per-cell
            // paint callback.
            let edit_value: string | undefined;
            if (edit_syntax === 'markdown' && editable) {
                if (dirty) {
                    edit_value = cached_markdown_edit_text(
                        dirty,
                        () => dirty_value_edit_text(dirty, edit_syntax),
                    );
                    if (xlsx_edit_writes_formula(dirty.value, dirty.valueRuns?.runs)) {
                        edit_value = formula_move_retargeter?.(
                            edit_value,
                            sheet_index,
                            dirty.valueEditOrder ?? 0,
                        ) ?? edit_value;
                    }
                } else {
                    const loaded = loaded_row?.[source_column];
                    if (loaded) {
                        edit_value = cached_markdown_edit_text(
                            loaded,
                            () => cell_edit_text(loaded, edit_syntax),
                        );
                        if (loaded.formula !== undefined) {
                            edit_value = formula_move_retargeter?.(
                                loaded.formula,
                                sheet_index,
                            ) ?? loaded.formula;
                        }
                    }
                }
            }
            // Read at paint time against the deadline, so no re-render is needed
            // to end it: the timer damages these cells and this returns false.
            const flash_bg = history_flash_covers(
                history_flash_ref.current,
                display_column,
                row,
                Date.now(),
            )
                ? history_flash_rgba(high_contrast)
                : undefined;
            // Git compare paint state: a whole-row band for added/deleted rows,
            // and a per-cell before/after via the same diff_base channel the
            // Diff toggle uses. Deleted rows carry the original content as the
            // row itself (see CompareDataSource.read_rows), struck through by
            // the `compare_deleted` overlay flag.
            const compare_status = git_compare
                ? get_compare_status(source_display_row)
                : undefined;
            const compare_base = git_compare
                ? get_compare_base(source_display_row, source_column, show_formatting)
                : undefined;
            const compare_bg = compare_status !== undefined
                ? compare_row_bgs[compare_status]
                : undefined;
            let overlay: CellEditOverlay | undefined;
            if (editable_cells || dirty || dependent_formula_affected || highlight_bg || flash_bg
                || compare_bg || compare_base !== undefined) {
                overlay = {
                    editable,
                    ...(edit_value !== undefined ? { edit_value } : {}),
                    // `refused` is narrower than `!editable` on purpose: it means
                    // "editing is on here and we are refusing this cell", which is
                    // the only situation where Glide's paste path needs closing. A
                    // read-only sheet is not refusing anything — it never offered —
                    // and it does reach this branch, via highlight_bg, which is
                    // plain view state independent of edit mode.
                    refused: editable_cells && (source_row === undefined || pending_removal),
                    ...value_overlay,
                    // Compare's before-text rides the Diff toggle's channel; no
                    // dirty_value, so the "after" side is the cell's own text.
                    ...(compare_base !== undefined ? { diff_base: compare_base } : {}),
                    // A deleted row's cells are the original content, struck
                    // through whole (there is no "after" side to diff against).
                    ...(compare_status === 'deleted' || pending_removal
                        ? { compare_deleted: true as const }
                        : {}),
                    // The flash outranks every persistent tint for its half
                    // second, so the region an undo changed is legible even where
                    // the cells are also dirty, conflicted, or highlighted — which
                    // after an undo of a cell edit they usually are. All of those
                    // come back when it expires; nothing about them is lost.
                    bg: flash_bg ?? (pending_removal
                        ? compare_row_bgs.deleted
                        : dirty
                        ? key !== undefined && conflicted_keys_ref.current.has(key)
                            ? conflict_bg
                            : dirty_bg
                        : highlight_bg ?? compare_bg),
                };
            }
            const grid_cell = build_grid_cell(
                source_column,
                loaded_row,
                show_formatting,
                overlay,
                font_size_px,
                // Cells taller than one default row get soft wrapping — including
                // vertical merges whose constituent rows remain at default height.
                // An active toolbar fit keeps wrapping too. It samples only loaded
                // rows and has a width ceiling, so fitting is never permission to
                // clip capped, unsampled, or subsequently edited text.
                auto_fit_active
                    || get_cell_height(row, display_column) > default_row_height,
                link_modifier_held,
                diff_colors,
            );
            if (source_row === undefined) return grid_cell;
            const dirty_formula_source = edit_syntax === 'markdown'
                && dirty !== undefined
                && xlsx_edit_writes_formula(dirty.value, dirty.valueRuns?.runs)
                ? dirty.value
                : undefined;
            const dirty_formula = dirty_formula_source === undefined
                ? undefined
                : formula_move_retargeter?.(
                    dirty_formula_source,
                    sheet_index,
                    dirty?.valueEditOrder ?? 0,
                ) ?? dirty_formula_source;
            const loaded_formula = loaded_cell?.formula === undefined
                ? undefined
                : formula_move_retargeter?.(loaded_cell.formula, sheet_index)
                    ?? loaded_cell.formula;
            const formula = dirty_formula ?? (
                dirty === undefined && edit_syntax === 'markdown'
                    ? loaded_formula
                    : undefined
            );
            return {
                ...grid_cell,
                clipboardData: {
                    source: clipboard_source,
                    location: [source_column, source_row],
                    gridLocation: [display_column, row],
                    projectionGeneration: mapping_generation,
                    rowIdentity: { kind: 'source', sourceRow: source_row },
                    ...(formula === undefined ? {} : { formula }),
                },
            };
        },
        // version: bumps when a page lands so the closure (and the redraw effect) refresh.
        [
            link_modifier_held,
            get_row,
            show_formatting,
            version,
            git_compare,
            // `version` above also bumps when a compareDiff sidecar lands, so
            // freshly-diffed cells repaint through the same channel as pages.
            get_compare_status,
            get_compare_base,
            compare_row_bgs,
            pending_projection,
            pending_rendered_rows,
            removal_rendered_rows,
            editable_cells,
            edit_syntax,
            font_size_px,
            source_column_for_display,
            get_source_row,
            get_highlight_background,
            store,
            get_cell_height,
            auto_fit_active,
            default_row_height,
            // A theme switch re-derives the tints, so the callback must close
            // over the new ones (the full-region repaint effect below then
            // damages the cells already painted with the old ones).
            dirty_bg,
            conflict_bg,
            diff_colors,
            diff_mode,
            high_contrast,
            value_overlay_for_cell,
            clipboard_source,
            mapping_generation,
            formula_move_retargeter,
            sheet_index,
        ],
    );

    /**
     * Every mutation Glide performs, as the batch it performed it in.
     *
     * Glide already assembles a paste, a fill, a multi-cell delete and a single
     * overlay commit each as one array, and `source` names which. Taking the
     * batch rather than `onCellEdited` per item is what makes a paste one
     * undoable gesture instead of a thousand, and one store publication instead
     * of a thousand.
     */
    const on_cells_edited = useCallback(
        (items: readonly EditListItem[], source: CellEditSource): boolean | 'refused' => {
            // The admission gates are the batch's, applied once: past the close
            // barrier `post_pending_edits` refuses to publish, so an edit
            // committed after it would sit in the store and never reach the host.
            if (
                !editable_cells_ref.current
                || edit_admission_is_fenced()
                || save_in_flight_ref.current
            ) return 'refused';
            if (source === 'edit' && overlay_admission_revoked_ref.current) return 'refused';
            const open_overlay = open_overlay_row_ref.current;
            if (
                source === 'edit'
                && open_overlay !== null
                && open_overlay.edit_session_id !== edit_session_id_ref.current
            ) return 'refused';
            // The replay reservation belongs here too, and BEFORE the auto-grow
            // below: `run_edit_gesture` drops a gesture that is not admitted, so a
            // row grown on the way past would persist a durable height for text
            // that never reached the store. `editable_cells` does not cover this —
            // it excludes a save and a highlight in flight, not a replay.
            if (gestures_admitted !== undefined && !gestures_admitted()) return 'refused';

            const stale_cut_identity = items.some((item) => [
                item.movedFromRowIdentity,
                item.targetRowIdentity,
            ].some((identity) => {
                if (identity === undefined) return false;
                const display = pending_projection.display_row_for_identity(identity);
                if (display === undefined) return true;
                const projected = pending_projection.row_at(display);
                if (identity.kind === 'pending') {
                    return !(
                        (projected?.kind === 'pending' || projected?.kind === 'replacement')
                        && projected.row.id === identity.pendingRowId
                    );
                }
                return projected?.kind !== 'source'
                    || projected.identity?.sourceRow !== identity.sourceRow;
            }));
            if (stale_cut_identity) {
                host_bridge.postMessage({
                    type: 'showWarning',
                    message: 'The cut source row no longer exists, so nothing was pasted.',
                });
                return 'refused';
            }

            const edits: CellValueEdit[] = [];
            const pending_before = pending_store.snapshot();
            const pending_cell_edits: Array<{
                pendingRowId: string;
                sourceColumn: number;
                cell: PendingRowCell | undefined;
            }> = [];
            // A cut batch needs one shared explicit order on both its source
            // clears and destinations. Paste/fill formula intent needs an order
            // even when its text happens to equal the persisted formula: it was
            // still chosen after any earlier pending move. Overlay edits remain
            // lazy so closing an unchanged editor is a genuine no-op.
            const move_gesture = edit_syntax === 'markdown'
                && items.some((item) => item.movedFrom !== undefined
                    || item.movedFromRowIdentity !== undefined);
            const formula_gesture = edit_syntax === 'markdown'
                && source !== 'edit'
                && items.some(({ value }) => {
                    const text = value.kind === GridCellKind.Text
                        ? value.data ?? ''
                        : value.kind === GridCellKind.Custom && is_rich_text_cell(value)
                            ? value.data.edit_value ?? ''
                            : '';
                    return xlsx_edit_writes_formula(text, undefined);
                });
            const explicit_gesture_order = move_gesture || formula_gesture
                ? issue_value_edit_order()
                : undefined;
            let pending_gesture_order = explicit_gesture_order;
            const damaged: { cell: Item }[] = [];
            const grown_rows = new Set<number>();
            const growth_requests: Array<{
                row: number;
                text: string;
                displayColumn: number;
                arm: 'pending' | 'source';
                pendingRowId?: string;
            }> = [];
            // Rectangular gestures repeat each display row across every column
            // they cover, and resolving one costs a page-map lookup and a
            // temporary location object; a 10x100 paste would pay for ten rows a
            // thousand times. `null` is cached too — an unresolvable row is
            // unresolvable for the whole batch.
            const source_rows = new Map<number, number | null>();
            const resolve_source_row = (row: number): number | null => {
                const cached = source_rows.get(row);
                if (cached !== undefined) return cached;
                const resolved = commit_source_row(row) ?? null;
                source_rows.set(row, resolved);
                return resolved;
            };
            for (const {
                location,
                value,
                movedFrom,
                movedFromRowIdentity,
                targetRowIdentity,
                targetSourceColumn,
            } of items) {
                const [display_column, row] = location;
                const target_display_row = targetRowIdentity === undefined
                    ? row
                    : pending_projection.display_row_for_identity(targetRowIdentity);
                // The batch-level identity check above makes this unreachable
                // for a cut. Keep the per-item refusal for malformed or future
                // callers so a stable identity never falls back to stale
                // numeric coordinates.
                if (target_display_row === undefined) continue;
                // A late finish from an overlay belongs to the source column it
                // opened on, even if a projection has since assigned its display
                // slot to another column. Paste/fill/delete are current gestures,
                // so they continue to resolve through the live projection.
                const captured = open_overlay;
                const captured_matches = source === 'edit'
                    && captured !== null
                    && captured.display_cell[0] === display_column
                    && captured.display_cell[1] === row;
                const source_column = captured_matches
                    ? captured.source_column
                    : targetSourceColumn ?? source_column_for_display(display_column);
                if (source_column === undefined) continue;
                const projected_row = pending_projection.row_at(target_display_row);
                if (projected_row?.kind === 'removal' && targetRowIdentity === undefined) continue;
                const stable_pending_row = targetRowIdentity?.kind === 'pending'
                    ? pending_rows.appendedRows.find(
                        (candidate) => candidate.id === targetRowIdentity.pendingRowId,
                    )
                    : undefined;
                const pending_row = stable_pending_row ?? (
                    projected_row?.kind === 'pending' || projected_row?.kind === 'replacement'
                        ? projected_row.row
                        : undefined
                );
                if (targetRowIdentity?.kind === 'pending' && pending_row === undefined) continue;
                if (pending_row !== undefined) {
                    const text = value.kind === GridCellKind.Text
                        ? value.data ?? ''
                        : value.kind === GridCellKind.Custom && is_rich_text_cell(value)
                            ? value.data.edit_value ?? ''
                            : '';
                    const parsed = parse_cell_edit(text, edit_syntax);
                    const existing = pending_row.cells[source_column];
                    pending_gesture_order ??= issue_value_edit_order();
                    const moved_source = movedFrom === undefined
                        ? undefined
                        : movedFromRowIdentity === undefined
                            ? { row: movedFrom[1], col: movedFrom[0] }
                            : (() => {
                                const display = pending_projection.display_row_for_identity(
                                    movedFromRowIdentity,
                                );
                                const projected = display === undefined
                                    ? undefined
                                    : pending_projection.row_at(display);
                                const physical = movedFromRowIdentity.kind === 'source'
                                    ? movedFromRowIdentity.sourceRow
                                    : projected?.kind === 'pending'
                                        || projected?.kind === 'replacement'
                                        ? projected.intendedPhysicalRow
                                        : undefined;
                                return physical === undefined ? undefined : {
                                    row: physical,
                                    col: movedFrom[0],
                                };
                            })();
                    const next: PendingRowCell | undefined = parsed.text === ''
                        && parsed.rich === undefined
                        && existing?.link == null
                        && existing?.movedFrom === undefined
                        ? undefined
                        : {
                            value: parsed.text,
                            ...(parsed.rich === undefined ? {} : { valueRuns: parsed.rich }),
                            ...(existing?.link === undefined ? {} : { link: existing.link }),
                            valueEditOrder: pending_gesture_order,
                            ...(xlsx_edit_writes_formula(parsed.text, parsed.rich?.runs)
                                && formula_reference_bases !== undefined
                                ? {
                                    formulaReferenceBases: formula_reference_bases(parsed.text),
                                }
                                : {}),
                            ...(moved_source === undefined
                                ? existing?.movedFrom === undefined
                                    ? {}
                                    : { movedFrom: existing.movedFrom }
                                : {
                                movedFrom: {
                                    row: moved_source.row,
                                    col: moved_source.col,
                                    order: pending_gesture_order,
                                    ...(movedFromRowIdentity === undefined ? {} : {
                                        rowIdentity: movedFromRowIdentity,
                                    }),
                                    ...(existing?.movedFrom === undefined ? {} : {
                                        previous: [
                                            ...(existing.movedFrom.previous ?? []),
                                            {
                                                sourceRow: existing.movedFrom.row,
                                                sourceCol: existing.movedFrom.col,
                                                destinationRow: projected_row?.kind === 'pending'
                                                    || projected_row?.kind === 'replacement'
                                                    ? projected_row.intendedPhysicalRow
                                                    : target_display_row,
                                                destinationCol: source_column,
                                                order: existing.movedFrom.order,
                                                ...(existing.movedFrom.rowIdentity === undefined
                                                    ? {}
                                                    : {
                                                        sourceRowIdentity:
                                                            existing.movedFrom.rowIdentity,
                                                    }),
                                                destinationRowIdentity: {
                                                    kind: 'pending' as const,
                                                    pendingRowId: pending_row.id,
                                                },
                                            },
                                        ],
                                    }),
                                },
                                }),
                        };
                    pending_cell_edits.push({
                        pendingRowId: pending_row.id,
                        sourceColumn: source_column,
                        cell: next,
                    });
                    growth_requests.push({
                        row: target_display_row,
                        text,
                        displayColumn: display_column,
                        arm: 'pending',
                        pendingRowId: pending_row.id,
                    });
                    damaged.push({ cell: [display_column, target_display_row] });
                    continue;
                }
                // Resolve source identity here as well as at overlay-open time.
                // get_cell_content's `editable` gate covers the overlay and
                // Glide's activation/delete paths, but Glide's paste path never
                // consults `allowOverlay` (see the `readonly` flag in
                // cell-renderer.ts), so this is the second of the two guards
                // keeping an unresolvable row from landing an edit under the
                // wrong key.
                //
                // Glide passes `overlay.cell` (the coordinates the editor opened
                // on) to onFinishEditing, so an exact late overlay finish uses the
                // captured row as well as the captured column. Other gestures use
                // current residency, with the capture only as an eviction fallback.
                const source_row = captured_matches
                    ? captured.source_row
                    : targetRowIdentity?.kind === 'source'
                        ? targetRowIdentity.sourceRow
                        : resolve_source_row(target_display_row);
                if (source_row === null) continue;
                const text = value.kind === GridCellKind.Text
                    ? value.data ?? ''
                    : value.kind === GridCellKind.Custom && is_rich_text_cell(value)
                        ? value.data.edit_value ?? ''
                        : '';
                const explicitly_ordered = move_gesture
                    || (
                        formula_gesture
                        && xlsx_edit_writes_formula(text, undefined)
                    );
                edits.push({
                    source_row,
                    source_col: source_column,
                    value: text,
                    ...(captured_matches && captured.opened_value !== undefined
                        ? { openedValue: captured.opened_value }
                        : {}),
                    ...(
                        explicit_gesture_order === undefined || !explicitly_ordered
                            ? {}
                            : { editOrder: explicit_gesture_order }
                    ),
                    ...(movedFrom === undefined ? {} : {
                        movedFrom: {
                            source_row: movedFromRowIdentity === undefined
                                ? movedFrom[1]
                                : movedFromRowIdentity.kind === 'source'
                                    ? movedFromRowIdentity.sourceRow
                                    : (() => {
                                        const display = pending_projection
                                            .display_row_for_identity(movedFromRowIdentity);
                                        const projected = display === undefined
                                            ? undefined
                                            : pending_projection.row_at(display);
                                        return projected?.kind === 'pending'
                                            || projected?.kind === 'replacement'
                                            ? projected.intendedPhysicalRow
                                            : movedFrom[1];
                                    })(),
                            source_col: movedFrom[0],
                            ...(movedFromRowIdentity === undefined ? {} : {
                                row_identity: movedFromRowIdentity,
                            }),
                        },
                    }),
                });

                // Auto-grow the row to fit hard line breaks (Shift+Alt+Enter),
                // mirroring the old renderer. Only ever grows a row, never
                // shrinks a user-sized one; repaints the whole row at the new
                // height. The measurement and the resize live in
                // `auto_grow_row_for_text` because this is not the only path that
                // commits a value — see there.
                //
                // No longer gated on a `transformed` prop — which no longer
                // exists, having had no readers left once this was its last one.
                // It used to be, because a height was persisted under the display
                // row it was measured at, which under a permutation named some
                // other source row — durable corruption, so the whole affordance
                // was suppressed rather than risked. Now the height goes up as a
                // display interval and the host maps it through the permutation
                // it installed, so a permuted view is no different from an
                // unpermuted one; and `row_heights` is itself display-keyed, so
                // the comparison below is a like-for-like read at this row. This
                // site *could* resolve `source_row` (it did so just above, to key
                // the edit) and deliberately does not: one display→source mapper,
                // host-side, is the invariant the design rests on.
                growth_requests.push({
                    row: target_display_row,
                    text,
                    displayColumn: display_column,
                    arm: 'source',
                });
                damaged.push({ cell: [display_column, target_display_row] });
            }

            const envelope_refusal_before = envelope_refusal_sequence_ref.current;
            let pending_changed = false;
            const deferred_paste = pending_paste_history_ref.current;
            pending_paste_history_ref.current = null;
            const has_pending_arm = pending_cell_edits.length > 0 || deferred_paste !== null;
            if (has_pending_arm && edits.length > 0 && !can_capture_edits(edits)) {
                if (deferred_paste !== null) {
                    const current = pending_store.snapshot();
                    const rollback = pending_store.stage_replace(
                        edit_session_id,
                        current,
                        deferred_paste.before,
                    );
                    if (rollback?.valid()) {
                        rollback.commit();
                        rollback.notify();
                    }
                }
                host_bridge.postMessage({
                    type: 'showWarning',
                    message: 'The paste target is no longer loaded, so nothing was changed.',
                });
                return 'refused' as const;
            }
            if (pending_cell_edits.length > 0) {
                const pending_row_heights = new Map<string, number>();
                for (const request of growth_requests) {
                    if (request.arm !== 'pending' || request.pendingRowId === undefined) continue;
                    const height = planned_auto_grow_height(
                        request.row,
                        request.text,
                        request.displayColumn,
                    );
                    if (height !== undefined) {
                        pending_row_heights.set(
                            request.pendingRowId,
                            Math.max(
                                pending_row_heights.get(request.pendingRowId) ?? 0,
                                height,
                            ),
                        );
                    }
                }
                pending_changed = pending_store.set_cells(
                    edit_session_id,
                    pending_cell_edits,
                    pending_row_heights,
                );
                if (pending_changed) {
                    for (const request of growth_requests) {
                        if (request.arm === 'pending'
                            && request.pendingRowId !== undefined
                            && pending_row_heights.has(request.pendingRowId)) {
                            grown_rows.add(request.row);
                        }
                    }
                }
                if (
                    !pending_changed
                    && envelope_refusal_sequence_ref.current !== envelope_refusal_before
                ) {
                    if (deferred_paste !== null) {
                        const current = pending_store.snapshot();
                        const rollback = pending_store.stage_replace(
                            edit_session_id,
                            current,
                            deferred_paste.before,
                        );
                        if (rollback?.valid()) {
                            rollback.commit();
                            rollback.notify();
                        }
                    }
                    host_bridge.postMessage({
                        type: 'showWarning',
                        message: 'The edit is too large to keep as pending changes.',
                    });
                    return 'refused' as const;
                }
                const admitted_rows_remain = deferred_paste !== null
                    && [...deferred_paste.rowIds].every((id) =>
                        pending_store.row_index(id) !== undefined);
                if (!pending_changed && deferred_paste !== null && !admitted_rows_remain) {
                    const current = pending_store.snapshot();
                    const rollback = pending_store.stage_replace(
                        edit_session_id,
                        current,
                        deferred_paste.before,
                    );
                    if (rollback?.valid()) {
                        rollback.commit();
                        rollback.notify();
                    }
                    host_bridge.postMessage({
                        type: 'showWarning',
                        message: 'The paste is too large to keep as pending changes.',
                    });
                    // Claim the batch without committing its source-cell arm;
                    // falling back to per-cell edits would violate all-or-nothing.
                    return 'refused' as const;
                }
            }
            const label = edit_history_label(
                source,
                edits.length + pending_cell_edits.length,
            );
            const pending_after_cells = pending_store.snapshot();
            const formula_conflict_staging = edits.length === 0
                ? undefined
                : pending_store.stage_clear_formula_conflicts(
                    edit_session_id,
                    edits.map((edit) => ({
                        rowIdentity: { kind: 'source' as const, sourceRow: edit.source_row },
                        sourceColumn: edit.source_col,
                    })),
                );
            const pending_after = formula_conflict_staging?.next ?? pending_after_cells;
            const pending_history_rows = deferred_paste === null
                ? [...new Set(pending_cell_edits.map((edit) => edit.pendingRowId))]
                    .flatMap((id) => {
                        const index = pending_store.row_index(id);
                        return index === undefined ? [] : [{ id, index }];
                    })
                : undefined;
            const structural_history_changes = pending_row_history_changes(
                history_capture?.worksheet ?? {
                    sheetIndex: sheet_index,
                    ...(sheet_meta.name === undefined
                        ? {}
                        : { sheetName: sheet_meta.name }),
                    ...(sheet_meta.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet_meta.worksheetId }),
                },
                deferred_paste?.before ?? pending_before,
                pending_after,
                pending_history_rows,
            );
            const source_result = edits.length > 0
                ? commit_edits_result(
                    edits,
                    label,
                    structural_history_changes,
                    formula_conflict_staging === undefined
                        ? []
                        : [formula_conflict_staging.mutation],
                )
                : 'noop' as const;
            const source_committed = source_result === 'committed';
            if (source_result === 'refused') {
                if (pending_changed || deferred_paste !== null) {
                    const rollback = pending_store.stage_replace(
                        edit_session_id,
                        pending_after_cells,
                        deferred_paste?.before ?? pending_before,
                    );
                    if (rollback?.valid()) {
                        rollback.commit();
                        rollback.notify();
                    }
                }
                host_bridge.postMessage({
                    type: 'showWarning',
                    message: 'The paste could not be applied completely, so nothing was changed.',
                });
                return 'refused' as const;
            }
            if (envelope_refusal_sequence_ref.current !== envelope_refusal_before) {
                if (pending_changed || deferred_paste !== null) {
                    const current = pending_store.snapshot();
                    const rollback = pending_store.stage_replace(
                        edit_session_id,
                        current,
                        deferred_paste?.before ?? pending_before,
                    );
                    if (rollback?.valid()) {
                        rollback.commit();
                        rollback.notify();
                    }
                }
                host_bridge.postMessage({
                    type: 'showWarning',
                    message: 'The edit is too large to keep as pending changes.',
                });
                return 'refused' as const;
            }
            if ((pending_changed || deferred_paste !== null) && source_result === 'noop') {
                record_pending_row_gesture(
                    label,
                    deferred_paste?.before ?? pending_before,
                    pending_after_cells,
                );
            }

            // Height is part of the gesture's commit, not an eager side effect of
            // assembling it. Apply growth only after the corresponding cell arm
            // survived envelope/history validation; every refusal above returns
            // before this point with both source and pending heights untouched.
            for (const request of growth_requests) {
                if (request.arm !== 'source' || !source_committed) continue;
                if (auto_grow_row_for_text(
                    request.row,
                    request.text,
                    request.displayColumn,
                    false,
                )) grown_rows.add(request.row);
            }

            // A grown row repaints whole: its other columns are laid out at the
            // new height too. Its own cells' individual entries drop out first —
            // a row is repainted once, not once plus once per cell in it.
            if (grown_rows.size > 0) {
                const cell_damage = damaged.filter(({ cell }) => !grown_rows.has(cell[1]));
                damaged.length = 0;
                damaged.push(...cell_damage);
                for (const row of grown_rows) {
                    for (let column = 0; column < display_column_count; column++) {
                        damaged.push({ cell: [column, row] });
                    }
                }
            }
            if (damaged.length > 0) grid_ref.current?.updateCells(damaged);
            // Claim the batch, so Glide does not also replay it one cell at a
            // time through `onCellEdited`.
            return true;
        },
        [
            auto_grow_row_for_text,
            can_capture_edits,
            commit_edits_result,
            display_column_count,
            edit_admission_is_fenced,
            gestures_admitted,
            edit_session_id,
            editable_cells_ref,
            edit_session_id_ref,
            issue_value_edit_order,
            edit_syntax,
            history_capture,
            pending_projection,
            pending_store,
            planned_auto_grow_height,
            record_pending_row_gesture,
            sheet_index,
            sheet_meta.name,
            sheet_meta.worksheetId,
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
                const opened_value = read_live_edit_ref.current()?.original;
                if (
                    opened_value !== undefined
                    && open_overlay_row_ref.current !== null
                ) {
                    open_overlay_row_ref.current.opened_value = opened_value;
                }
                refresh_live_uncommitted();
                return () => {
                    // Ordering matters: on_cells_edited already ran by the time Glide
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
                if (save_in_flight_ref.current || edit_admission_is_fenced()) return;
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
                const current = captured?.display_cell
                    ?? grid_selection_ref.current.current?.cell;
                if (!current) return;
                // Resolve the merge-aware target before deciding whether the
                // traversal crossed the outer boundary. A merge anchor can be
                // the last reachable stop without occupying the literal edge.
                const target = move_sequential_cell(
                    current,
                    navigation,
                    row_count_ref.current,
                    display_column_count_ref.current,
                    (r, c) => merge_index_ref.current.is_covered(r, c),
                );
                const append_column = may_append_rows_ref.current
                    ? sequential_append_target_column(
                        current,
                        navigation,
                        row_count_ref.current,
                        display_column_count_ref.current,
                        target,
                    )
                    : undefined;
                if (append_column !== undefined) {
                    void append_and_focus_ref.current(append_column);
                    return;
                }
                pending_editor_navigation_ref.current = [target[0], target[1]];
            };
            const handle_finished: CsvCellEditorProps['onFinishedEditing'] = (
                next,
                movement,
            ) => {
                if (next === undefined) pending_editor_navigation_ref.current = null;
                const committed = props.onFinishedEditing(next, movement);
                if (committed === false) return false;
                if (next !== undefined) return true;
                // Escape retracts the speculative overlay projection after Glide
                // has closed it. Ordinary commits are published by the dirty-store
                // effect; a document unload does not unmount React effects and
                // therefore leaves the latest per-keystroke projection intact.
                queueMicrotask(() => {
                    const edits = Object.fromEntries(store.snapshot());
                    post_pending_edits(Object.keys(edits).length > 0 ? edits : null);
                });
                return true;
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
        edit_admission_is_fenced,
        post_pending_edits,
        refresh_live_uncommitted,
        release_open_overlay_row,
        save_in_flight_ref,
        store,
    ]);

    // Custom overlay editor (Enter/Tab advance, Shift/Alt+Enter newline, Esc
    // cancel). Rich Markdown cells adapt through the same text editor so their
    // canvas renderer can remain active throughout Edit mode.
    const provide_editor = useCallback<ProvideEditorCallback<GridCell>>(
        (cell) => {
            if (
                save_in_flight_ref.current
                || !editable_cells
                || (cell.kind !== GridCellKind.Text
                    && !(cell.kind === GridCellKind.Custom && is_rich_text_cell(cell)))
            ) return undefined;
            // disablePadding/disableStyling: the editor carries its own
            // .cell-editor-input border + background, so suppress Glide's overlay box.
            return { editor: tracking_editor, disablePadding: true, disableStyling: true };
        },
        [editable_cells, save_in_flight_ref, tracking_editor],
    );

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
                    // Sweep to the physical column under the pointer: inside a
                    // horizontal merge the canonicalized location snaps to the
                    // anchor, which would yank the sweep to the merge's left edge.
                    const hovered_column = args.kind === 'cell'
                        ? (args.physicalLocation ?? args.location)[0]
                        : args.location[0];
                    const columns = header_drag_columns(
                        drag,
                        hovered_column,
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
            if (
                args.kind === 'header'
                && args.location[0] >= 0
                && (args.buttons & 1) === 0
            ) {
                schedule_header_tooltip(args.location[0], args.bounds);
            } else if (args.kind !== 'cell' || args.location[0] < 0 || args.location[1] < 0) {
                hide_cell_tooltip();
            } else if ((args.buttons & 1) !== 0) {
                // Primary button down (drag-select / resize) — no tooltip.
                hide_cell_tooltip();
            } else {
                // Deliberately the merge-resolved bounds, not physicalBounds: a
                // merge paints its text across the whole block, so that block is
                // the rectangle overflow must be measured against — a covered
                // cell's own width would pop tooltips for text that fits fine.
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
            // Physical geometry, not the merge-canonicalized location/bounds:
            // inside a vertical merge the event reports the anchor row and the
            // block's full bounds, but the boundary under the pointer belongs to
            // the physical row — dragging a merge's bottom edge must resize its
            // last row, and interior boundaries must stay reachable.
            const row = (args.physicalLocation ?? args.location)[1];
            const bounds = args.physicalBounds ?? args.bounds;
            const hit = row_boundary_hit(
                row,
                bounds.y,
                bounds.height,
                // localEventY is relative to the canonicalized bounds; rebase it
                // onto the physical cell.
                args.localEventY + args.bounds.y - bounds.y,
                ROW_RESIZE_TOLERANCE_PX,
            );
            row_resize_ref.current?.set_target(
                hit
                    ? {
                          row: hit.row,
                          boundary_y: hit.boundary_y,
                          height: effective_row_height(hit.row, false),
                      }
                    : null,
            );
        },
        [
            display_column_count,
            effective_row_height,
            hide_cell_tooltip,
            row_markers,
            schedule_cell_tooltip,
            schedule_header_tooltip,
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
                pending_projection_ref.current.rowCount,
            )
            : null;
        apply_row_resize(selected ?? [{ start: row, end: row }], height);
    }, [apply_row_resize]);

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
            // No merge snapping needed: the vendored grid canonicalizes every
            // selection (anchor cell + whole-merge range) before echoing it here.
            write_grid_selection(sel);
        },
        [display_column_count, row_markers, select_all, write_grid_selection],
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
        max_rows = max_copy_rows_for_columns(
            selection.source_columns.length,
            undefined,
            undefined,
            sheet_meta.estimatedRowBytes,
        ),
    ) => {
        // Snapshot the displayed edit layers once per copy. A row must still be
        // resident before edits are overlaid: one known dirty cell must not make an
        // otherwise-unloaded row look complete or suppress the nonresident warning.
        const dirty = store.snapshot();
        const live = read_live_edit();
        const get_displayed_row = (
            row_index: number,
        ): (RenderedCell | null)[] | undefined => {
            const projected = pending_projection.row_at(row_index);
            if (projected !== undefined && projected.kind !== 'source') {
                const pending_id = projected.kind === 'pending'
                    || projected.kind === 'replacement'
                    ? projected.row.id
                    : undefined;
                const structural_row = projected.kind === 'removal'
                    ? removal_rendered_rows.get(projected.removal.sourceRow)
                    : pending_rendered_rows.get(projected.row.id);
                if (
                    pending_id === undefined
                    || live?.kind !== 'pending'
                    || live.pendingRowId !== pending_id
                ) return structural_row ?? [];
                const displayed = [...(structural_row ?? [])];
                displayed[live.sourceColumn] = {
                    raw: live.value,
                    formatted: live.value,
                    bold: false,
                    italic: false,
                    rawType: live.value === '' ? 'empty' : 'string',
                };
                return displayed;
            }
            // `source_cells` is the row's *cells* (formerly misnamed source_row),
            // renamed so the real source row below can carry that name.
            const source_cells = get_row_ref.current(
                projected?.kind === 'source' ? projected.sourceDisplayRow : row_index,
            );
            if (source_cells === undefined) return undefined;
            // Edit keys are source-keyed, so the dirty/live lookups need this row's
            // canonical identity. Bailing when it is unresolved matches the residency
            // rule above: a row must be resident before edits are overlaid, and a
            // resolved source row is exactly what residency means here.
            const source_row = projected?.kind === 'source'
                ? projected.identity?.sourceRow
                    ?? get_source_row(projected.sourceDisplayRow)
                : get_source_row(row_index);
            if (source_row === undefined) return undefined;
            let displayed_row: (RenderedCell | null)[] | undefined;
            for (const source_column of selection.source_columns) {
                const key = cell_key(source_row, source_column);
                const displayed_value = live?.kind === 'source' && live.key === key
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
            max_rows,
        );
        const warning = copy_truncation_message(result);
        if (warning) {
            host_bridge.postMessage({ type: 'showWarning', message: warning });
        }
        const header = include_header
            ? selection.source_columns.map((source_column) =>
                effective_column_names?.[source_column]
                || sheet_meta.columnNames?.[source_column]
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
        effective_column_names,
        get_source_row,
        merge_index,
        pending_projection,
        pending_rendered_rows,
        read_live_edit,
        removal_rendered_rows,
        sheet_meta.columnNames,
        sheet_meta.estimatedRowBytes,
        show_formatting,
        safe_write_to_clipboard,
        store,
    ]);

    const copy_rect = useCallback(
        (
            rect: Rectangle,
            include_header = false,
            max_rows = max_copy_rows_for_columns(
                rect.width,
                undefined,
                undefined,
                sheet_meta.estimatedRowBytes,
            ),
        ) => {
            copy_source_selection({
                y: rect.y,
                height: rect.height,
                source_columns: visible_source_columns.slice(
                    rect.x,
                    rect.x + rect.width,
                ),
            }, include_header, max_rows);
        },
        [copy_source_selection, sheet_meta.estimatedRowBytes, visible_source_columns],
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
        // A page carries every source column even when most are hidden, so the
        // load budget must use the resident row width as well as the TSV width.
        const copy_row_limit = max_copy_rows_for_columns(Math.max(
            display_column_count,
            sheet_meta.columnCount,
        ), undefined, undefined, sheet_meta.estimatedRowBytes);
        const copy_row_count = Math.min(row_count, copy_row_limit);
        // Keep an operation-owned hold through synchronous serialization. Two
        // concurrent copies can have their load waiters settle together; without
        // separate pins, the first copy's trim could evict the second's rows.
        const residency_pin = pin_rows(0, copy_row_count - 1);
        try {
            const loaded = await ensure_rows_loaded(0, copy_row_count - 1);
            // A sheet switch or reload cleared the cache mid-load: abandon the
            // copy rather than overwrite the clipboard with a now-empty grid.
            if (!loaded) return;
            copy_rect({
                x: 0,
                y: 0,
                width: display_column_count,
                height: row_count,
            }, true, copy_row_limit);
        } finally {
            // The TSV is materialized synchronously before the clipboard promise
            // starts, so bulk-loaded pages no longer need waiter protection.
            unpin_rows(residency_pin);
            trim_rows();
        }
    }, [
        copy_rect,
        display_column_count,
        ensure_rows_loaded,
        pin_rows,
        row_count,
        sheet_meta.columnCount,
        sheet_meta.estimatedRowBytes,
        trim_rows,
        unpin_rows,
    ]);

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
            if (edit_admission_is_fenced() || save_in_flight_ref.current
                || (gestures_admitted !== undefined && !gestures_admitted())) return;
            const projected = pending_projection.row_at(row);
            // A Pending Tail Removal is a review snapshot, not the source row
            // currently occupying the same numeric display coordinate. Under a
            // transform that coordinate can resolve to an unrelated retained
            // row, so no mutating cell action may fall through to source lookup.
            if (projected?.kind === 'removal') return;
            const row_identity: RowIdentity | undefined = projected?.kind === 'pending'
                || projected?.kind === 'replacement'
                ? { kind: 'pending', pendingRowId: projected.row.id }
                : (() => {
                    // Source-keyed, so resolve the row's identity. A dirty cell was
                    // resident when committed, but its page may since be evicted.
                    const source_display_row = projected?.kind === 'source'
                        ? projected.sourceDisplayRow
                        : row;
                    const source_row = get_source_row(source_display_row);
                    return source_row === undefined
                        ? undefined
                        : { kind: 'source', sourceRow: source_row };
                })();
            if (row_identity === undefined) return;
            const before = pending_store.snapshot();
            const plan = plan_pending_move_discard(
                store.snapshot(),
                before,
                [{ rowIdentity: row_identity, sourceColumn: source_column }],
            );
            if (plan.count === 0) return;
            const after = pending_changes_after_move_discard(before, plan);
            const source_staging = store.stage_writes(
                edit_session_id,
                [...plan.sourceKeys].map((key) => ({ key, entry: undefined })),
                true,
            );
            const pending_staging = pending_store.stage_replace(
                edit_session_id,
                before,
                after,
                true,
            );
            if (source_staging === undefined || pending_staging === undefined) return;
            const staged: StagedMutation[] = [source_staging, pending_staging];
            // Preserve the existing undoable single-pending-cell behavior. A
            // cross-store cut discard is deliberately not recorded until cell
            // history can restore both stores as one action; recording only the
            // structural half would recreate the data-loss state this closure
            // prevents.
            if (plan.sourceKeys.size === 0 && history_capture !== undefined) {
                const changes = pending_row_history_changes(
                    history_capture.worksheet,
                    before,
                    after,
                );
                if (changes.length > 0) {
                    staged.push(history_capture.history.stage_record({
                        label: 'Discard cell edit',
                        changes,
                    }));
                }
            }
            if (!commit_staged_transaction(staged)) return;
            const damage = plan.cells.flatMap((cell) => {
                const display_row = pending_projection.display_row_for_identity(cell.rowIdentity);
                const display_col = display_column_for_source(cell.sourceColumn);
                return display_row === undefined || display_col === undefined
                    ? []
                    : [{ cell: [display_col, display_row] as Item }];
            });
            grid_ref.current?.updateCells(damage.length > 0
                ? damage
                : [{ cell: [display_column, row] }]);
        },
        [
            display_column_for_source,
            edit_admission_is_fenced,
            edit_session_id,
            get_source_row,
            gestures_admitted,
            history_capture,
            pending_projection,
            pending_store,
            save_in_flight_ref,
            store,
        ],
    );

    /** The cell whose hyperlink is being edited, snapshotted at menu-click time
     *  along with the link the dialog opens with. Null when no dialog is up. */
    const [hyperlink_dialog, set_hyperlink_dialog] = useState<{
        row: number;
        display_col: number;
        source_col: number;
        row_identity: RowIdentity;
        edit_session_id: string;
        initial: CellHyperlink | null;
    } | null>(null);

    const release_hyperlink_dialog_pin = useCallback(() => {
        const pin = hyperlink_dialog_pin_ref.current;
        if (pin === null) return;
        hyperlink_dialog_pin_ref.current = null;
        unpin_rows_ref.current(pin);
    }, []);
    useEffect(() => () => release_hyperlink_dialog_pin(), [release_hyperlink_dialog_pin]);

    const open_hyperlink_dialog = useCallback(
        (row: number, display_col: number, source_col: number) => {
            const projected = pending_projection.row_at(row);
            if (projected?.kind === 'removal') return;
            const row_identity: RowIdentity | undefined = projected?.kind === 'pending'
                || projected?.kind === 'replacement'
                ? projected.identity
                : projected?.kind === 'source'
                    ? projected.identity
                    : (() => {
                        const source_row = get_source_row(row);
                        return source_row === undefined
                            ? undefined
                            : { kind: 'source' as const, sourceRow: source_row };
                    })();
            if (row_identity === undefined || edit_session_id === undefined) return;
            release_hyperlink_dialog_pin();
            if (row_identity.kind === 'source') {
                const loader_row = projected?.kind === 'source'
                    ? projected.sourceDisplayRow
                    : row;
                hyperlink_dialog_pin_ref.current = pin_rows_ref.current(loader_row, loader_row);
            }
            set_hyperlink_dialog({
                row,
                display_col,
                source_col,
                row_identity,
                edit_session_id,
                initial: cell_hyperlink(display_col, row) ?? null,
            });
        },
        [
            cell_hyperlink,
            edit_session_id,
            get_source_row,
            pending_projection,
            release_hyperlink_dialog_pin,
        ],
    );

    const close_hyperlink_dialog = useCallback(() => {
        release_hyperlink_dialog_pin();
        set_hyperlink_dialog(null);
        grid_ref.current?.focus();
    }, [release_hyperlink_dialog_pin]);

    const restore_focus_after_hyperlink_unmount = useCallback(() => {
        const epoch = ++hyperlink_focus_restore_epoch_ref.current;
        // Child layout cleanup runs before this commit installs the replacement
        // session's refs. A microtask observes that committed state without
        // guessing how long rendering takes.
        window.queueMicrotask(() => {
            if (hyperlink_focus_restore_epoch_ref.current !== epoch) return;
            if (!editable_cells_ref.current) return;
            const active = document.activeElement;
            const has_surviving_target = active instanceof HTMLElement
                && active !== document.body
                && active !== document.documentElement
                && active.isConnected;
            if (!has_surviving_target) focus_grid();
        });
    }, [focus_grid]);
    useEffect(() => () => {
        hyperlink_focus_restore_epoch_ref.current += 1;
    }, []);

    const hyperlink_dialog_admitted = edit_mode
        && csv_editable
        && edit_session_id !== undefined
        && hyperlink_dialog?.edit_session_id === edit_session_id
        && !close_barrier_active;

    // A stable GridShell can outlive the edit session that opened this dialog.
    // Remove the stale draft only when that admission actually ends; temporary
    // save/highlight locks must preserve it until request_save can fold it.
    useEffect(() => {
        if (hyperlink_dialog_admitted) return;
        release_hyperlink_dialog_pin();
        set_hyperlink_dialog(null);
    }, [hyperlink_dialog_admitted, release_hyperlink_dialog_pin]);

    const apply_hyperlink = useCallback(
        (next: CellHyperlink | null) => {
            const target = hyperlink_dialog;
            // Same admission gate as every other mutation path here. Past the
            // close barrier `post_pending_edits` refuses to publish, so a link
            // committed after it would sit in the store and never reach the
            // host — a silently dropped edit rather than a refused one.
            if (
                !target
                || target.edit_session_id !== edit_session_id_ref.current
                || !editable_cells_ref.current
                || edit_admission_is_fenced()
                || save_in_flight_ref.current
                || (gestures_admitted !== undefined && !gestures_admitted())
            ) return false;
            const pending_row_id = target.row_identity.kind === 'pending'
                ? target.row_identity.pendingRowId
                : undefined;
            const pending_before = pending_row_id === undefined
                ? undefined
                : pending_store.snapshot();
            const refusal_before = envelope_refusal_sequence_ref.current;
            const committed = pending_row_id === undefined
                ? commit_hyperlinks([{
                    source_row: (target.row_identity as Extract<
                        RowIdentity,
                        { kind: 'source' }
                    >).sourceRow,
                    source_col: target.source_col,
                    value: next,
                }])
                : (() => {
                    const row = pending_store.snapshot().appendedRows.find(
                        (candidate) => candidate.id === pending_row_id,
                    );
                    if (!row) return false;
                    return pending_store.set_hyperlink(
                        edit_session_id,
                        row.id,
                        target.source_col,
                        next,
                    );
                })();
            if (!committed) {
                if (envelope_refusal_sequence_ref.current !== refusal_before) {
                    show_pending_size_warning();
                }
                return false;
            }
            if (pending_before !== undefined) {
                record_pending_row_gesture(
                    next === null ? 'Remove hyperlink' : 'Edit hyperlink',
                    pending_before,
                    pending_store.snapshot(),
                );
            }
            release_hyperlink_dialog_pin();
            set_hyperlink_dialog(null);
            grid_ref.current?.focus();
            // Damage explicitly: a link change on an already-dirty cell leaves
            // the dirty key set unchanged, so the tint effect below sees no
            // transition and would never repaint the new link presentation.
            // Through the same source-keyed pipeline as every other such
            // repaint, so one source row showing at several display rows — and
            // a merge whose anchor is off-screen — are handled here too.
            const cells = target.row_identity.kind === 'source'
                ? source_key_damage(
                    new Set([`${target.row_identity.sourceRow}:${target.source_col}`]),
                    visible_ref.current,
                    display_column_for_source,
                    source_row_for_projected_display,
                    merged_ranges,
                ).map(({ cell }) => ({ cell: cell as Item }))
                : [{ cell: [target.display_col, target.row] as Item }];
            if (cells.length > 0) grid_ref.current?.updateCells(cells);
            return true;
        },
        [
            commit_hyperlinks,
            display_column_for_source,
            edit_admission_is_fenced,
            gestures_admitted,
            source_row_for_projected_display,
            hyperlink_dialog,
            merged_ranges,
            pending_store,
            record_pending_row_gesture,
            release_hyperlink_dialog_pin,
            save_in_flight_ref,
            show_pending_size_warning,
        ],
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

    /** The cell's external-link URL, pre-validated for immediate feedback
     *  (the host re-validates before anything reaches the OS opener).
     *  Internal links are render-only in v1, so they yield null here too. */
    const external_link_url = useCallback(
        (display_column: number, row: number): string | null => {
            const link = cell_hyperlink(display_column, row);
            if (link?.kind !== 'external') return null;
            return parse_http_external_url(link.target);
        },
        [cell_hyperlink],
    );

    const open_external_url = useCallback((url: string) => {
        host_bridge.postMessage({ type: 'openExternal', url });
    }, []);

    // Ctrl/Cmd+click on a linked cell opens the link; everything else falls
    // through to the row-marker click logic this wraps.
    const on_cell_clicked = useCallback(
        (cell: Item, event: CellClickedEventArgs) => {
            const [display_column, row] = cell;
            if (
                display_column >= 0
                && (event.ctrlKey || event.metaKey)
                && !event.shiftKey
                && event.button === 0
            ) {
                const url = external_link_url(display_column, row);
                if (url !== null) {
                    event.preventDefault();
                    open_external_url(url);
                    return;
                }
            }
            row_markers.on_cell_clicked(cell, event);
        },
        [external_link_url, open_external_url, row_markers],
    );

    // Controlled keyboard nav. Tab/Shift+Tab use row-major wrapping and
    // view-mode hjkl keeps merge-aware movement; arrows (and range extension,
    // shortcuts) stay native to Glide, which steps past merges itself.
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
            if (
                decision.kind === 'sequential'
                && (decision.navigation === 'next' || decision.navigation === 'below')
                && may_append_rows_ref.current
            ) {
                const append_column = sequential_append_target_column(
                    cur,
                    decision.navigation,
                    row_count,
                    display_column_count,
                    target,
                );
                if (append_column !== undefined) {
                    void append_and_focus_ref.current(append_column);
                    return;
                }
            }
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
            if (!preview_mode) {
                const scroller = grid_root_ref.current?.querySelector<HTMLElement>(
                    '.dvn-scroller',
                );
                if (scroller) {
                    on_scroll_position_change({
                        left: scroller.scrollLeft,
                        top: scroller.scrollTop,
                    });
                }
            }
            // Scroll moves cells under the cursor; drop any open tooltip so it
            // can't float over the wrong content mid-scroll.
            hide_cell_tooltip();
            const start = range.y;
            const end = range.y + range.height - 1;
            const source_end = Math.min(end, pending_projection.sourceRowCount - 1);
            if (start <= source_end) {
                const intervals = pending_projection.source_display_intervals([{
                    start,
                    end: source_end,
                }]);
                if (intervals.length > 0) {
                    ensure_rows(intervals[0].start, intervals[intervals.length - 1].end);
                }
            }
            // A merged block can be visible while its anchor row sits above the
            // viewport; the grid paints the block from the anchor's content, so
            // that row's page must be resident too. ensure_rows_loaded requests
            // without moving the loader's viewport (which tracks what Glide
            // actually shows). Fire-and-forget: the version bump on landing
            // repaints the block. One call per distinct anchor row, and only
            // for merges actually on screen horizontally, so a scroll event
            // costs one pass over the (capped) merge list and no redundant
            // loader waiters.
            let anchor_rows: Set<number> | undefined;
            for (const m of vertical_merged_ranges) {
                if (m.y >= start || m.y + m.height <= start) continue;
                if (m.x >= range.x + range.width || m.x + m.width <= range.x) continue;
                (anchor_rows ??= new Set()).add(m.y);
            }
            if (anchor_rows) {
                for (const row of anchor_rows) {
                    const projected = pending_projection.row_at(row);
                    if (projected?.kind === 'source') {
                        void ensure_rows_loaded(
                            projected.sourceDisplayRow,
                            projected.sourceDisplayRow,
                        );
                    }
                }
            }
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
            ensure_rows_loaded,
            hide_cell_tooltip,
            on_preview_visible_row_change,
            on_scroll_position_change,
            pending_preview_scroll,
            preview_mode,
            restore_pending_preview_row,
            pending_projection.sourceRowCount,
            pending_projection,
            vertical_merged_ranges,
        ],
    );

    // Kick off the first page before the initial region callback arrives.
    useEffect(() => {
        if (!has_visible_columns) return;
        const intervals = pending_projection.source_display_intervals([{
            start: 0,
            end: Math.min(40, pending_projection.sourceRowCount - 1),
        }]);
        if (intervals.length > 0) {
            ensure_rows(intervals[0].start, intervals[intervals.length - 1].end);
        }
    }, [ensure_rows, has_visible_columns, pending_projection]);

    // Full-region repaint on the discrete events that change content or
    // editability of *every* already-painted cell: a page landing (version
    // bump), the formatting toggle (raw ↔ formatted), the edit-mode toggle
    // (flips each cell's allowOverlay), and a font-size or edit-tint change
    // (each cell carries both in its theme override). A parent re-render alone
    // does not reliably invalidate Glide's per-cell cache, so damage explicitly.
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
    }, [
        version,
        pending_payload_revision,
        show_formatting,
        editable_cells,
        display_column_count,
        font_size_px,
        // A theme switch re-derives the tints; without these, already-painted
        // dirty/conflicted cells keep the previous theme's color until they
        // happen to be damaged for some other reason.
        dirty_bg,
        conflict_bg,
        // The Diff toggle (and its theme colors) change what dirty cells
        // paint, so flipping it must damage the already-painted ones too.
        diff_mode,
        diff_colors,
    ]);

    // Targeted tint repaint: damage only the cells whose dirty/conflict tint
    // actually changed, not the whole viewport. Single-cell edits/discards
    // already damage their own cell inline; this covers the bulk transitions
    // (save-clear of saved keys, "Discard Conflicted"/"Discard All", and reload
    // drift flipping cells in/out of the conflicted set) without rebuilding
    // every visible cell on each keystroke.
    const prev_dirty_keys_ref = useRef<Set<string>>(new Set());
    const prev_conflicted_keys_ref = useRef<Set<string>>(new Set());
    const prev_pending_formula_impact_ref = useRef<FormulaSheetImpact>();
    const prev_formula_results_ref = useRef<ReadonlyMap<string, string>>(new Map());
    const prev_source_formula_results_ref = useRef<ReadonlyMap<string, string>>(new Map());
    useEffect(() => {
        const next_dirty = new Set(dirty_cells.keys());
        const changed = changed_tint_keys(
            prev_dirty_keys_ref.current,
            next_dirty,
            prev_conflicted_keys_ref.current,
            conflicted_keys,
        );
        const previous_formula_impact = prev_pending_formula_impact_ref.current;
        if (previous_formula_impact !== pending_formula_impact) {
            for (const { row, column } of previous_formula_impact?.cells() ?? []) {
                if (pending_formula_impact?.has(row, column) !== true) {
                    changed.add(`${row}:${column}`);
                }
            }
            for (const { row, column } of pending_formula_impact?.cells() ?? []) {
                if (previous_formula_impact?.has(row, column) !== true) {
                    changed.add(`${row}:${column}`);
                }
            }
            prev_pending_formula_impact_ref.current = pending_formula_impact;
        }
        if (prev_formula_results_ref.current !== formula_results) {
            for (const [key, value] of prev_formula_results_ref.current) {
                if (formula_results?.get(key) !== value) changed.add(key);
            }
            for (const [key, value] of formula_results ?? []) {
                if (prev_formula_results_ref.current.get(key) !== value) changed.add(key);
            }
            prev_formula_results_ref.current = formula_results ?? new Map();
        }
        if (prev_source_formula_results_ref.current !== source_formula_results) {
            for (const [key, value] of prev_source_formula_results_ref.current) {
                if (source_formula_results?.get(key) !== value) changed.add(key);
            }
            for (const [key, value] of source_formula_results ?? []) {
                if (prev_source_formula_results_ref.current.get(key) !== value) changed.add(key);
            }
            prev_source_formula_results_ref.current = source_formula_results ?? new Map();
        }
        prev_dirty_keys_ref.current = next_dirty;
        // conflicted_keys is a fresh useMemo Set (new identity each change, never
        // mutated in place), so it can be stashed as the snapshot directly — no copy.
        prev_conflicted_keys_ref.current = conflicted_keys;
        const grid = grid_ref.current;
        if (!grid || changed.size === 0) return;
        // Dirty keys are source-keyed, so a changed key's row is a source row and
        // cannot be used as a display coordinate. source_key_damage maps source →
        // display over the visible range (handling one source row appearing at
        // several display rows) and repairs merges whose off-screen anchor holds
        // the block's tint.
        const cells = source_key_damage(
            changed,
            visible_ref.current,
            display_column_for_source,
            source_row_for_projected_display,
            merged_ranges,
        ).map(({ cell }) => ({ cell: cell as Item }));
        for (const key of changed) {
            const coordinate = parse_cell_key(key);
            if (!coordinate) continue;
            const display_row = pending_display_row_by_physical.get(coordinate.sourceRow);
            const display_column = display_column_for_source(coordinate.sourceColumn);
            if (display_row !== undefined && display_column !== undefined) {
                cells.push({ cell: [display_column, display_row] });
            }
        }
        if (cells.length > 0) grid.updateCells(cells);
    }, [
        dirty_cells,
        conflicted_keys,
        pending_formula_impact,
        formula_results,
        source_formula_results,
        display_column_for_source,
        pending_display_row_by_physical,
        source_row_for_projected_display,
        merged_ranges,
    ]);

    const previous_highlights_ref = useRef<SheetCellHighlightState['cells']>();
    useEffect(() => {
        const previous = previous_highlights_ref.current;
        const next = cell_highlights?.cells;
        previous_highlights_ref.current = next;
        const changed = changed_highlight_keys(previous, next);
        if (changed.size === 0) return;
        // Same source-keyed pipeline as the tint effect above (visible-cell scan
        // plus the off-screen-anchor merge repair).
        const cells = source_key_damage(
            changed,
            visible_ref.current,
            display_column_for_source,
            source_row_for_projected_display,
            merged_ranges,
        ).map(({ cell }) => ({ cell: cell as Item }));
        if (cells.length > 0) grid_ref.current?.updateCells(cells);
    }, [
        cell_highlights,
        display_column_for_source,
        source_row_for_projected_display,
        merged_ranges,
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
        const has_explicit_column_selection = grid_selection.columns.length > 0;
        const has_explicit_row_selection = grid_selection.rows.length > 0;
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
        const selection_has_structural_rows = (selected_rows ?? [{ start: row, end: row }])
            .some((interval) => {
                for (
                    let candidate = Math.max(
                        interval.start,
                        pending_projection.deletedBandStart,
                    );
                    candidate <= interval.end;
                    candidate += 1
                ) {
                    const projected = pending_projection.row_at(candidate);
                    if (projected !== undefined && projected.kind !== 'source') return true;
                }
                return false;
            });
        const highlight_selection = current_highlight_selection();
        const pending_selection_has_highlight = highlight_selection?.displayRows.some(
            (interval) => {
                for (
                    let candidate = Math.max(interval.start, pending_projection.pendingBandStart);
                    candidate <= interval.end;
                    candidate += 1
                ) {
                    const projected = pending_projection.row_at(candidate);
                    if (
                        (projected?.kind === 'pending' || projected?.kind === 'replacement')
                        && highlight_selection.sourceColumns.some(
                            (column) => projected.row.highlights?.[column] !== undefined,
                        )
                    ) return true;
                }
                return false;
            },
        ) === true;
        const highlight_cell_count = highlight_selection
            ? highlight_selection.displayRows.reduce(
                (total, interval) => total + interval.end - interval.start + 1,
                0,
            ) * highlight_selection.sourceColumns.length
            : 0;
        // Source-keyed dirty probe. An unresolved source row reports `false` rather
        // than guessing: it is also the case where discard_edit would have no key to
        // remove, so hiding "Discard edit" is the consistent answer.
        const menu_projected_row = pending_projection.row_at(row);
        const menu_source_row = menu_projected_row?.kind === 'source'
            ? menu_projected_row.identity?.sourceRow
                ?? get_source_row(menu_projected_row.sourceDisplayRow)
            : menu_projected_row === undefined
                ? get_source_row(row)
                : undefined;
        const menu_dirty_key = menu_source_row === undefined
            ? undefined
            : cell_key(menu_source_row, source_col);
        const pending_menu_cell = menu_projected_row?.kind === 'pending'
            || menu_projected_row?.kind === 'replacement'
            ? menu_projected_row.row.cells[source_col]
            : undefined;
        const menu_row_identity: RowIdentity | undefined = pending_menu_cell !== undefined
            && (menu_projected_row?.kind === 'pending'
                || menu_projected_row?.kind === 'replacement')
            ? { kind: 'pending', pendingRowId: menu_projected_row.row.id }
            : menu_source_row === undefined
                ? undefined
                : { kind: 'source', sourceRow: menu_source_row };
        const discard_edit_cell_count = menu_row_identity === undefined
            ? 0
            : plan_pending_move_discard(
                dirty_cells,
                pending_rows,
                [{ rowIdentity: menu_row_identity, sourceColumn: source_col }],
            ).count;
        const menu_link_url = external_link_url(display_col, row);
        // Hyperlinks are a workbook concept: offered on the sheets that edit as
        // markdown (Excel), never on CSV/TSV, and only where the cell is
        // actually editable and its source identity resolved — the same gate
        // the commit path needs to have a durable key.
        const may_edit_hyperlink = editable_cells
            && edit_syntax === 'markdown'
            && menu_projected_row?.kind !== 'removal'
            && (menu_source_row !== undefined
                || menu_projected_row?.kind === 'pending'
                || menu_projected_row?.kind === 'replacement');
        cell_menu_items = cell_context_menu_items({
            ...(menu_link_url !== null
                ? {
                    on_open_link: () => open_external_url(menu_link_url),
                    on_copy_link: () => void safe_write_to_clipboard(menu_link_url),
                }
                : {}),
            ...(may_edit_hyperlink
                ? {
                    on_edit_hyperlink: () =>
                        open_hyperlink_dialog(row, display_col, source_col),
                    has_hyperlink: cell_hyperlink(display_col, row) !== undefined,
                }
                : {}),
            dirty: discard_edit_cell_count > 0,
            discard_edit_cell_count,
            has_distinct_copy_selection: has_explicit_column_selection
                || has_explicit_row_selection
                || has_distinct_copy_selection(
                    range,
                    merge_index.is_anchor(row, display_col),
                ),
            preview_mode,
            can_highlight: highlight_selection !== null,
            // Hiding rows is offered in edit mode: it is a transform like any
            // other, and the host admits it from the panel holding the session.
            // Preview keeps its refusal — natural source order is a trust
            // boundary there.
            can_hide_rows: !!selected_rows
                && transform_sections
                && !transform_pending
                && !preview_mode
                && !selection_has_structural_rows,
            show_disabled_hide_rows: selection_has_structural_rows,
            selected_row_count,
            selected_column_count: hide_column_targets.length,
            can_clear_highlight: pending_selection_has_highlight
                || highlight_selection_may_have_renderable_highlight(
                    highlight_selection,
                    cell_highlights?.cells,
                    (display_row) => {
                        const projected = pending_projection.row_at(display_row);
                        if (projected?.kind === 'source') {
                            return projected.identity?.sourceRow
                                ?? get_source_row(projected.sourceDisplayRow);
                        }
                        if (projected !== undefined) return undefined;
                        const raw = pending_projection.source_display_intervals([{
                            start: display_row,
                            end: display_row,
                        }])[0]?.start;
                        return raw === undefined ? undefined : get_source_row(raw);
                    },
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
                if (has_explicit_column_selection) {
                    copy_source_selection({
                        y: 0,
                        height: row_count,
                        source_columns: selected_column_sources,
                    }, true);
                } else if (has_explicit_row_selection) {
                    if (selected_rows) copy_display_rows(selected_rows);
                } else if (range) {
                    copy_rect(range);
                }
            },
            on_highlight: (color) => mutate_highlight_selection({ type: 'set', color }),
            on_clear_highlight: () => mutate_highlight_selection({ type: 'clear' }),
            on_hide_rows: () => {
                if (selected_rows) {
                    on_hide_rows(pending_projection.source_display_intervals(selected_rows));
                }
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
                getRowAccessibilityLabel={get_row_accessibility_label}
                columns={columns}
                maxColumnWidth={MAX_COLUMN_WIDTH_PX}
                maxColumnAutoWidth={MAX_AUTO_FIT_COLUMN_WIDTH_PX}
                overscrollX={LAST_COLUMN_RESIZE_GUTTER_PX}
                mergedRanges={merged_ranges}
                getCellContent={get_cell_content}
                rowHeight={get_row_height}
                rowMarkers={row_marker_options}
                theme={theme}
                smoothScrollX
                smoothScrollY
                scrollOffsetX={initial_scroll_position?.left}
                scrollOffsetY={initial_scroll_position?.top}
                getCellsForSelection={true}
                gridSelection={grid_selection}
                onGridSelectionChange={on_grid_selection_change}
                drawHeader={draw_header}
                drawCell={draw_pending_divider}
                onHeaderClicked={focus_header_column}
                onHeaderContextMenu={on_header_context_menu}
                onVisibleRegionChanged={on_visible_region_changed}
                onColumnResize={handle_column_resize}
                onItemHovered={on_item_hovered}
                onCellsEdited={on_cells_edited}
                onPaste={editable_cells
                    ? on_append_rows === undefined ? true : allow_rectangular_paste
                    : false}
                onPasteRowsNeeded={can_request_append_rows
                    ? append_rows_for_paste
                    : undefined}
                pasteTopologyKey={paste_topology_key}
                cutValidationKey={cut_validation_key}
                clipboardSource={clipboard_source}
                clipboardProjectionGeneration={mapping_generation}
                onClipboardPasteError={(message) => {
                    host_bridge.postMessage({ type: 'showWarning', message });
                }}
                // Do not expose Glide's drag-to-fill affordance. It is easy to
                // trigger accidentally and duplicates values rather than helping
                // with Table Viewer's viewing and lightweight editing workflow.
                fillHandle={false}
                onCellClicked={on_cell_clicked}
                customRenderers={custom_renderers}
                onCellContextMenu={on_cell_context_menu}
                onKeyDown={on_key_down}
                provideEditor={provide_editor}
            />
            {may_offer_append_dock && (
                <AppendDock
                    remaining_capacity={remaining_append_capacity}
                    busy={append_in_flight}
                    on_add_rows={add_rows_from_dock}
                    secondary_open={composer_open}
                    secondary_actions={(
                        <AppendComposer
                            column_labels={composer_column_labels}
                            draft={composer_draft}
                            on_draft_change={set_composer_draft}
                            remaining_capacity={remaining_append_capacity}
                            busy={append_in_flight}
                            open={composer_open}
                            on_open_change={set_composer_open}
                            on_stage_rows={stage_composed_rows}
                        />
                    )}
                />
            )}
            {append_in_flight && (
                <span className="sr-only" role="status" aria-live="polite">
                    Adding rows. Editing is temporarily unavailable.
                </span>
            )}
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
            {hyperlink_dialog && hyperlink_dialog_admitted && (
                <HyperlinkDialog
                    // Remount on a different cell so the draft state starts
                    // from that cell's link rather than the previous one's.
                    key={[
                        hyperlink_dialog.edit_session_id,
                        hyperlink_dialog.row_identity.kind,
                        hyperlink_dialog.row_identity.kind === 'source'
                            ? hyperlink_dialog.row_identity.sourceRow
                            : hyperlink_dialog.row_identity.pendingRowId,
                        hyperlink_dialog.source_col,
                    ].join(':')}
                    ref={hyperlink_dialog_ref}
                    initial={hyperlink_dialog.initial}
                    disabled={!editable_cells}
                    on_commit={apply_hyperlink}
                    on_cancel={close_hyperlink_dialog}
                    on_focused_unmount={restore_focus_after_hyperlink_unmount}
                />
            )}
            {rename_column && (
                <RenameColumnDialog
                    initial={rename_column.initial}
                    column_names={effective_column_names ?? []}
                    source_column={rename_column.sourceColumn}
                    on_commit={apply_column_rename}
                    on_cancel={() => {
                        set_rename_column(null);
                        window.setTimeout(() => grid_ref.current?.focus(), 0);
                    }}
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
                const row_menu = context_menu;
                const selected_pending_ids = new Set(row_menu.pending_row_ids);
                const selected_removal_rows = new Set(
                    row_menu.tail_removal_source_rows,
                );
                const selected_row_count = row_menu.selected_row_count;
                const only_pending = selected_pending_ids.size === selected_row_count;
                const only_removals = selected_removal_rows.size === selected_row_count;
                const has_structural_rows = selected_pending_ids.size > 0
                    || selected_removal_rows.size > 0;
                return (
                    <ContextMenu
                        x={row_menu.x}
                        y={row_menu.y}
                        aria_label={selected_row_count === 1
                            ? `Row actions for row ${row_menu.row_number}`
                            : `Row actions for ${selected_row_count} selected rows`}
                        items={row_context_menu_items({
                            selected_row_count,
                            // Offered in edit mode, refused in preview; see the
                            // cell menu's can_hide_rows above.
                            can_hide_rows: transform_sections
                                && !transform_pending
                                && !preview_mode
                                && !has_structural_rows,
                            show_disabled_hide_rows: has_structural_rows,
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
                            on_hide_rows: () => on_hide_rows(row_menu.source_display_rows),
                            ...(only_pending ? {
                                pending_row_count: selected_pending_ids.size,
                                on_remove_pending_rows: () => {
                                    remove_pending_rows([...selected_pending_ids]);
                                },
                            } : selected_pending_ids.size > 0 ? {
                                pending_row_count: selected_pending_ids.size,
                                show_disabled_remove_pending_rows: true,
                            } : {}),
                            ...(only_removals ? {
                                on_cancel_row_removals: () => {
                                    const before = pending_store.snapshot();
                                    cancel_tail_removals(before.tailRemovals.flatMap(
                                        (removal) => selected_removal_rows.has(removal.sourceRow)
                                            ? [removal.appendHistoryId]
                                            : [],
                                    ));
                                },
                            } : {}),
                            on_promote_row_to_header: () =>
                                on_promote_row_to_header(
                                    row_menu.source_display_rows[0]?.start
                                        ?? row_menu.row,
                                ),
                            on_copy_rows: () => {
                                const resolved_rows = new Set<number>();
                                {
                                    for (const interval of row_menu.source_display_rows) {
                                        for (let row = interval.start; row <= interval.end; row += 1) {
                                            const display = pending_projection
                                                .display_row_for_source_display(row);
                                            if (display !== undefined) resolved_rows.add(display);
                                        }
                                    }
                                    for (const id of selected_pending_ids) {
                                        const display = pending_projection.display_row_for_identity({
                                            kind: 'pending', pendingRowId: id,
                                        });
                                        if (display !== undefined) resolved_rows.add(display);
                                    }
                                    for (const sourceRow of selected_removal_rows) {
                                        const display = pending_projection.display_row_for_identity({
                                            kind: 'source', sourceRow,
                                        });
                                        if (display !== undefined) resolved_rows.add(display);
                                    }
                                }
                                const ordered_rows = [...resolved_rows]
                                    .sort((left, right) => left - right);
                                copy_source_selection({
                                    row_indices: ordered_rows,
                                    row_count: ordered_rows.length,
                                    source_columns: visible_source_columns,
                                });
                            },
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
                        {...(editable_cells
                            && edit_syntax === 'markdown'
                            && sheet_meta.excelFirstRowHeader?.active === true
                            ? {
                                rename_disabled: !header_column_can_be_renamed(
                                    sheet_meta,
                                    source_column,
                                ),
                                on_rename: () => {
                                    suppress_menu_restore_ref.current = true;
                                    set_rename_column({
                                        sourceColumn: source_column,
                                        initial: dirty_cells.get(
                                            `${header_source_row}:${source_column}`,
                                        )?.value
                                            ?? sheet_meta.columnHeaderEditTexts?.[source_column]
                                            ?? effective_column_names?.[source_column]
                                            ?? '',
                                    });
                                },
                            }
                            : {})}
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
