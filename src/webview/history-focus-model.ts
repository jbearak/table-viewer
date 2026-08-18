/**
 * Turning a committed replay's focus into a cursor position and a flash.
 *
 * Pure: no React, no Glide runtime, no timers. Everything here is a function of
 * the committed focus, the view the renderer currently holds, and — for the
 * flash — an explicit `now`, so the whole of it is testable without waiting for
 * anything. The GridShell that consumes it owns the one timer that turns a
 * deadline into a repaint.
 */

import type { CellRect } from './selection-glide';
import type { ColumnProjection } from './column-projection';
import type { HistoryReplayDisplayFocus } from '../history-replay-protocol';

/**
 * How long the replayed region stays tinted.
 *
 * Long enough to catch the eye across a sheet switch, short enough not to be
 * mistaken for the persistent yellow of a cell highlight.
 */
export const HISTORY_FLASH_DURATION_MS = 550;

/** A focus request App is holding for whichever GridShell can consume it. */
export interface PendingHistoryFocus {
    /** Monotonic, so a GridShell acknowledges exactly the request it applied. */
    readonly sequence: number;
    readonly sheetIndex: number;
    readonly displayRowStart: number;
    readonly displayRowEnd: number;
    readonly sourceColumnStart: number;
    readonly sourceColumnEnd: number;
    readonly mappingGeneration: number;
}

/**
 * Why a focus request did not move the cursor, or that it did.
 *
 * Reported rather than thrown, and distinguished rather than collapsed into a
 * boolean, because they are different things to tell the user: a hidden region
 * is a truthful "the replay landed somewhere you cannot see", while a stale
 * mapping is the renderer declining to guess.
 */
export type HistoryFocusOutcome =
    | { readonly kind: 'applied'; readonly cell: readonly [number, number]; readonly range: CellRect }
    | { readonly kind: 'rows-hidden' }
    | { readonly kind: 'columns-hidden' }
    | { readonly kind: 'stale-mapping' }
    | { readonly kind: 'empty-grid' };

export interface HistoryFocusView {
    readonly sheetIndex: number;
    readonly rowCount: number;
    readonly displayColumnCount: number;
    readonly mappingGeneration: number;
    readonly columnProjection: ColumnProjection;
}

/**
 * The display region a focus request names in the view the renderer holds now.
 *
 * Columns are projected HERE and not by the host: column visibility is
 * renderer-owned state the host has no copy of, so the request carries the
 * source-column interval and this resolves it.
 *
 * A hidden column is never substituted with a nearby visible one. Moving the
 * cursor to a cell the replay did not touch would be worse than not moving it:
 * the user would read the selection as "this is what changed".
 */
export function resolve_history_focus(
    request: PendingHistoryFocus,
    view: HistoryFocusView,
): HistoryFocusOutcome {
    if (request.sheetIndex !== view.sheetIndex) return { kind: 'stale-mapping' };
    // The host resolved these display rows against a mapping that has since
    // moved, so they describe a view that no longer exists.
    if (request.mappingGeneration !== view.mappingGeneration) return { kind: 'stale-mapping' };
    if (view.rowCount <= 0 || view.displayColumnCount <= 0) return { kind: 'empty-grid' };

    // Clamped rather than refused: rows arrive from the host and the renderer's
    // own row count is what Glide will index, so a request that overhangs it is
    // narrowed to what exists instead of selecting past the end.
    const row_start = Math.min(request.displayRowStart, view.rowCount - 1);
    const row_end = Math.min(request.displayRowEnd, view.rowCount - 1);
    if (row_start > row_end) return { kind: 'rows-hidden' };

    let column_start: number | undefined;
    let column_end: number | undefined;
    for (
        let source_column = request.sourceColumnStart;
        source_column <= request.sourceColumnEnd;
        source_column += 1
    ) {
        const display_column = view.columnProjection.source_to_visible[source_column];
        if (display_column === undefined || display_column >= view.displayColumnCount) continue;
        if (column_start === undefined || display_column < column_start) {
            column_start = display_column;
        }
        if (column_end === undefined || display_column > column_end) column_end = display_column;
    }
    if (column_start === undefined || column_end === undefined) return { kind: 'columns-hidden' };

    return {
        kind: 'applied',
        cell: [column_start, row_start],
        range: {
            x: column_start,
            y: row_start,
            width: column_end - column_start + 1,
            height: row_end - row_start + 1,
        },
    };
}

/**
 * A flash in progress.
 *
 * An absolute deadline, not a countdown: the timer that fires at it is an
 * implementation mechanism, and membership is a pure function of `now`, so a
 * test can ask what the grid paints at any instant without waiting for one.
 */
export interface HistoryFlash {
    readonly sequence: number;
    readonly range: CellRect;
    readonly expiresAt: number;
}

export function begin_history_flash(
    sequence: number,
    range: CellRect,
    now: number,
): HistoryFlash {
    return Object.freeze({ sequence, range, expiresAt: now + HISTORY_FLASH_DURATION_MS });
}

/** Whether a display cell is tinted by this flash at `now`. */
export function history_flash_covers(
    flash: HistoryFlash | null,
    display_column: number,
    display_row: number,
    now: number,
): boolean {
    if (flash === null || now >= flash.expiresAt) return false;
    const { x, y, width, height } = flash.range;
    return display_column >= x
        && display_column < x + width
        && display_row >= y
        && display_row < y + height;
}

/**
 * The cells to damage when a flash starts or ends.
 *
 * Bounded by the viewport, not by the flash: a replay can span a region far
 * larger than the screen — a paste over a hundred thousand rows — and repainting
 * what nobody is looking at costs the same as repainting what they are.
 */
export function history_flash_damage(
    flash: HistoryFlash,
    visible: CellRect,
): Array<{ readonly cell: readonly [number, number] }> {
    const x_start = Math.max(flash.range.x, visible.x);
    const x_end = Math.min(flash.range.x + flash.range.width, visible.x + visible.width);
    const y_start = Math.max(flash.range.y, visible.y);
    const y_end = Math.min(flash.range.y + flash.range.height, visible.y + visible.height);
    const damage: Array<{ readonly cell: readonly [number, number] }> = [];
    for (let column = x_start; column < x_end; column += 1) {
        for (let row = y_start; row < y_end; row += 1) {
            damage.push({ cell: [column, row] as const });
        }
    }
    return damage;
}

/** The display focus a committed replay reported, as a request App can hold. */
export function history_focus_request(
    sequence: number,
    sheet_index: number,
    display_focus: HistoryReplayDisplayFocus,
    source_column_start: number,
    source_column_end: number,
): PendingHistoryFocus {
    return Object.freeze({
        sequence,
        sheetIndex: sheet_index,
        displayRowStart: display_focus.displayRowStart,
        displayRowEnd: display_focus.displayRowEnd,
        sourceColumnStart: source_column_start,
        sourceColumnEnd: source_column_end,
        mappingGeneration: display_focus.mappingGeneration,
    });
}
