import type { SizedGridColumn } from '@glideapps/glide-data-grid';

/**
 * Pure grid-geometry helpers for the Glide renderer (Phase C). No DOM, no
 * Glide runtime imports (the SizedGridColumn import is type-only and erased),
 * so this module is fully unit-testable.
 */

/** Rows fetched per `requestRows` page. Windows are page-aligned so the loader
 *  cache (and the host-side LRU) key on stable boundaries. */
export const PAGE_SIZE = 100;

/** Glide's default header height (we don't override `headerHeight` on the
 *  DataEditor). The merge overlay clips its painting to below this so a block
 *  scrolled partly under the header never paints over the column letters. */
export const HEADER_HEIGHT_PX = 36;

export const MIN_COLUMN_WIDTH_PX = 40;
export const MAX_COLUMN_WIDTH_PX = 800;
export const DEFAULT_COLUMN_WIDTH_PX = 120;

/**
 * Page-aligned start indices whose pages intersect the inclusive visible range
 * [start_row, end_row]. A negative start clamps to 0; an inverted range yields [].
 */
export function get_needed_page_starts(start_row: number, end_row: number): number[] {
    if (end_row < start_row) return [];
    const first = Math.floor(Math.max(0, start_row) / PAGE_SIZE) * PAGE_SIZE;
    const last = Math.floor(Math.max(0, end_row) / PAGE_SIZE) * PAGE_SIZE;
    const starts: number[] = [];
    for (let s = first; s <= last; s += PAGE_SIZE) starts.push(s);
    return starts;
}

/** Clamp a column width to the renderer's allowed range. */
export function clamp_column_width(width: number): number {
    return Math.max(MIN_COLUMN_WIDTH_PX, Math.min(MAX_COLUMN_WIDTH_PX, width));
}

/** Spreadsheet column label for a 0-based index: 0→A, 25→Z, 26→AA, 702→AAA. */
export function column_letter(index: number): string {
    let n = index;
    let label = '';
    do {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
}

/**
 * Build Glide columns for a sheet. Table-viewer columns have no names, so the
 * title is the spreadsheet column letter. Persisted per-column widths (keyed by
 * column index) override the default and are clamped to the allowed range.
 */
export function build_grid_columns(
    column_count: number,
    widths: Record<number, number>,
): SizedGridColumn[] {
    const cols: SizedGridColumn[] = [];
    for (let i = 0; i < column_count; i++) {
        const w = widths[i];
        cols.push({
            title: column_letter(i),
            id: String(i),
            width: clamp_column_width(w ?? DEFAULT_COLUMN_WIDTH_PX),
        });
    }
    return cols;
}
