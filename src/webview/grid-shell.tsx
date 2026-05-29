import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    DataEditor,
    type DataEditorRef,
    type GridCell,
    type GridColumn,
    type Item,
    type Rectangle,
} from '@glideapps/glide-data-grid';
import type { SheetMeta } from '../data-source/interface';
import type { MergeRange } from '../types';
import { build_grid_columns } from './grid-model';
import { MergeIndex } from './merge-index';
import { build_grid_cell } from './cell-renderer';
import { row_height, type RowHeightOverrides } from './row-heights';
import { use_row_loader } from './use-row-loader';
import { use_vscode_theme } from './vscode-theme';
import { vscode_api } from './use-state-sync';
import '@glideapps/glide-data-grid/dist/index.css';

export interface GridShellProps {
    sheet_meta: SheetMeta;
    sheet_index: number;
    generation: number;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    row_heights: RowHeightOverrides;
    // Wired by the row-resize overlay (D-wire-3); accepted now so App's contract
    // is stable while the overlay lands.
    on_row_resize: (row: number, height: number) => void;
    merges: MergeRange[];
    preview_mode?: boolean;
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
    show_formatting,
    column_widths,
    on_column_resize,
    row_heights,
    merges,
    preview_mode = false,
}: GridShellProps): React.JSX.Element {
    const loader = use_row_loader(sheet_index, sheet_meta.rowCount, generation);
    const theme = use_vscode_theme();
    const grid_ref = useRef<DataEditorRef | null>(null);
    const visible_ref = useRef<Rectangle>({ x: 0, y: 0, width: 0, height: 0 });
    const last_preview_row = useRef<number | null>(null);

    const columns = useMemo<GridColumn[]>(
        () => build_grid_columns(sheet_meta.columnCount, column_widths),
        [sheet_meta.columnCount, column_widths],
    );

    const merge_index = useMemo(() => new MergeIndex(merges), [merges]);

    const { ensure_rows, get_row, version } = loader;

    const get_cell_content = useCallback(
        (cell: Item): GridCell => {
            const [col, row] = cell;
            return build_grid_cell(
                row,
                col,
                get_row(row),
                merge_index,
                show_formatting,
            );
        },
        // version: bumps when a page lands so the closure (and the redraw effect) refresh.
        [get_row, show_formatting, version, merge_index],
    );

    const get_row_height = useCallback(
        (row: number) => row_height(row_heights, row),
        [row_heights],
    );

    const on_visible_region_changed = useCallback(
        (range: Rectangle) => {
            visible_ref.current = range;
            const start = range.y;
            const end = range.y + range.height - 1;
            ensure_rows(start, end);
            if (preview_mode && last_preview_row.current !== start) {
                last_preview_row.current = start;
                vscode_api.postMessage({ type: 'visibleRowChanged', row: start });
            }
        },
        [ensure_rows, preview_mode],
    );

    // Kick off the first page before the initial region callback arrives.
    useEffect(() => {
        ensure_rows(0, 40);
    }, [ensure_rows]);

    // When a page lands (version bump), repaint the visible region so the new
    // cells replace their loading placeholders. A parent re-render alone does not
    // reliably invalidate Glide's per-cell cache, so damage explicitly.
    useEffect(() => {
        const grid = grid_ref.current;
        if (!grid) return;
        const r = visible_ref.current;
        if (r.width === 0 || r.height === 0) return;
        const cells: { cell: Item }[] = [];
        for (let row = r.y; row < r.y + r.height; row++) {
            for (let col = r.x; col < r.x + r.width; col++) {
                cells.push({ cell: [col, row] });
            }
        }
        grid.updateCells(cells);
    }, [version]);

    // Preview mode: host asks us to scroll a specific row into view.
    useEffect(() => {
        if (!preview_mode) return;
        const handler = (e: MessageEvent) => {
            const msg = e.data;
            if (msg && msg.type === 'scrollToRow' && typeof msg.row === 'number') {
                grid_ref.current?.scrollTo(0, msg.row, 'vertical');
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [preview_mode]);

    const handle_column_resize = useCallback(
        (_column: GridColumn, new_size: number, col_index: number) => {
            on_column_resize(col_index, new_size);
        },
        [on_column_resize],
    );

    return (
        <DataEditor
            ref={grid_ref}
            className="glide-grid"
            width="100%"
            height="100%"
            rows={sheet_meta.rowCount}
            columns={columns}
            getCellContent={get_cell_content}
            rowHeight={get_row_height}
            rowMarkers="number"
            theme={theme}
            smoothScrollX
            smoothScrollY
            getCellsForSelection={true}
            onVisibleRegionChanged={on_visible_region_changed}
            onColumnResize={handle_column_resize}
        />
    );
}
