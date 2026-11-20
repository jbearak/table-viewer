/**
 * Which rows of a selection a row fit can measure, and how many it must skip.
 *
 * Only a loaded row can be measured: a saved row whose page the row loader
 * holds, or a Pending Row the grid has rendered. The loader holds a few
 * thousand rows, so a selection of a million has at most that many to
 * measure, and the rest are skipped. Walking the selection row by row costs
 * as many steps as it has rows, so past the rows the loader holds the fit
 * walks those instead, plus the Pending Rows, and counts the skipped rows
 * from the selection's size. Both walks give the same answer.
 */

import type { DisplayRowInterval } from '../types';
import type { PendingRowProjection } from './pending-row-projection';

export interface RowFitTargetSources {
    readonly projection: Pick<
        PendingRowProjection,
        | 'row_at'
        | 'display_row_for_source_display'
        | 'inline_pending_display_rows'
        | 'deletedBandStart'
        | 'rowCount'
    >;
    /** The source-display rows the loader holds, as ascending inclusive ranges. */
    readonly resident_rows: () => readonly DisplayRowInterval[];
    /** Whether the loader holds this source-display row's cells. */
    readonly row_loaded: (source_display_row: number) => boolean;
    /** The canonical source row of a loaded source-display row. */
    readonly source_row_of: (source_display_row: number) => number | undefined;
    /** Whether the grid has rendered this Pending Row's cells. */
    readonly pending_rendered: (id: string) => boolean;
}

export interface RowFitTargets {
    /** Saved rows to measure, with the grid row each is drawn on. */
    readonly sources: readonly { readonly display_row: number; readonly source_row: number }[];
    /** Pending Rows to measure, by ID, with the grid row each is drawn on. */
    readonly pending: readonly { readonly display_row: number; readonly id: string }[];
    /** Rows of the selection that could not be measured. */
    readonly skipped: number;
}

/** Walk the selection row by row: the cheaper walk for a small selection. */
export function row_fit_targets_by_rows(
    intervals: readonly DisplayRowInterval[],
    sources: RowFitTargetSources,
): RowFitTargets {
    const { projection } = sources;
    const found_sources: { display_row: number; source_row: number }[] = [];
    const pending: { display_row: number; id: string }[] = [];
    let skipped = 0;
    for (const interval of intervals) {
        for (let display_row = interval.start; display_row <= interval.end; display_row += 1) {
            const projected = projection.row_at(display_row);
            if (projected?.kind === 'removal') continue;
            if (projected?.kind === 'pending' || projected?.kind === 'replacement') {
                if (sources.pending_rendered(projected.row.id)) {
                    pending.push({ display_row, id: projected.row.id });
                } else {
                    skipped += 1;
                }
                continue;
            }
            const source_display_row = projected?.sourceDisplayRow ?? display_row;
            const source_row = sources.row_loaded(source_display_row)
                ? projected?.identity?.sourceRow ?? sources.source_row_of(source_display_row)
                : undefined;
            if (source_row === undefined) {
                skipped += 1;
                continue;
            }
            found_sources.push({ display_row, source_row });
        }
    }
    return { sources: found_sources, pending, skipped };
}

function contains(intervals: readonly DisplayRowInterval[], row: number): boolean {
    let low = 0;
    let high = intervals.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const interval = intervals[middle];
        if (row < interval.start) high = middle - 1;
        else if (row > interval.end) low = middle + 1;
        else return true;
    }
    return false;
}

/**
 * Walk the rows the loader holds and the Pending Rows inside the selection:
 * the cheaper walk for a selection larger than the loader's rows.
 * `intervals` must be ascending and disjoint.
 */
export function row_fit_targets_by_resident_rows(
    intervals: readonly DisplayRowInterval[],
    sources: RowFitTargetSources,
): RowFitTargets {
    const { projection } = sources;
    const found_sources: { display_row: number; source_row: number }[] = [];
    const pending: { display_row: number; id: string }[] = [];
    let selected = 0;
    let removals = 0;
    for (const interval of intervals) {
        selected += interval.end - interval.start + 1;
        // Rows past the source band (removals at the end, appended rows) and
        // Pending Rows inline among the saved rows: few, and read one by one.
        const band_rows: number[] = [
            ...projection.inline_pending_display_rows(interval.start, interval.end),
        ];
        for (
            let display_row = Math.max(interval.start, projection.deletedBandStart);
            display_row <= interval.end && display_row < projection.rowCount;
            display_row += 1
        ) band_rows.push(display_row);
        for (const display_row of band_rows) {
            const projected = projection.row_at(display_row);
            if (projected?.kind === 'removal') removals += 1;
            else if (
                (projected?.kind === 'pending' || projected?.kind === 'replacement')
                && sources.pending_rendered(projected.row.id)
            ) pending.push({ display_row, id: projected.row.id });
        }
    }
    for (const range of sources.resident_rows()) {
        for (let source_display_row = range.start; source_display_row <= range.end; source_display_row += 1) {
            if (!sources.row_loaded(source_display_row)) continue;
            const display_row = projection.display_row_for_source_display(source_display_row);
            if (display_row === undefined || !contains(intervals, display_row)) continue;
            const projected = projection.row_at(display_row);
            if (projected !== undefined && projected.kind !== 'source') continue;
            const source_row = projected?.identity?.sourceRow ?? sources.source_row_of(source_display_row);
            if (source_row === undefined) continue;
            found_sources.push({ display_row, source_row });
        }
    }
    return {
        sources: found_sources,
        pending,
        skipped: selected - removals - found_sources.length - pending.length,
    };
}

/** The rows a fit measures, by whichever walk is shorter. */
export function row_fit_targets(
    intervals: readonly DisplayRowInterval[],
    sources: RowFitTargetSources,
): RowFitTargets {
    let selected = 0;
    for (const interval of intervals) selected += interval.end - interval.start + 1;
    let resident = 0;
    for (const range of sources.resident_rows()) resident += range.end - range.start + 1;
    return selected <= resident
        ? row_fit_targets_by_rows(intervals, sources)
        : row_fit_targets_by_resident_rows(intervals, sources);
}

/**
 * Whether `rows` hold a row a fit can size: anything but a row the session
 * will delete (a Pending Row Removal in the layout, or one past the last
 * row). In layout mode removed rows are skipped a run at a time, so a
 * selection of a million removed rows costs no more than one. In band mode
 * the band of rows removed at the end holds none and the appended rows all
 * are; the saved rows before them can include rows removed in place (a
 * sorted or filtered view over a layout), so those are read row by row as
 * before. That walk stops at the first row that is not removed, and a row
 * whose page is not loaded is not known to be removed: it reads at most the
 * rows the loader holds.
 */
export function rows_hold_fit_target(
    projection: Pick<
        PendingRowProjection,
        'layoutMode' | 'first_live_display_row_in' | 'rowCount' | 'deletedBandStart' | 'pendingBandStart'
    >,
    rows: readonly DisplayRowInterval[],
): boolean {
    for (const interval of rows) {
        const start = Math.max(0, interval.start);
        const end = Math.min(projection.rowCount - 1, interval.end);
        if (start > end) continue;
        if (projection.layoutMode) {
            if (projection.first_live_display_row_in(start, end) !== undefined) return true;
            continue;
        }
        if (end >= projection.pendingBandStart) return true;
        const source_end = Math.min(end, projection.deletedBandStart - 1);
        if (start <= source_end && projection.first_live_display_row_in(start, source_end) !== undefined) {
            return true;
        }
    }
    return false;
}

/** A row's painted extent on screen, top inclusive and bottom exclusive, in client pixels. */
export interface RowSpan {
    readonly top: number;
    readonly bottom: number;
}

/**
 * Where a row is painted, in the grid's own pixels, from the rectangle
 * Glide's `getBounds` reports for it in the page's: `frame.top` is the
 * grid canvas's top edge in the page, and `frame.scale` the page pixels to
 * one of the grid's, as Glide works them out. Glide reports a row one pixel
 * taller than it paints, and with its vertical scroll offset `ty` as is,
 * while it paints with `ty` rounded: `frame.shift` is that rounding,
 * `Math.round(ty) - ty`.
 */
export function painted_row_span(
    reported: { readonly y: number; readonly height: number },
    frame: { readonly top: number; readonly scale: number; readonly shift: number },
): RowSpan {
    const top = (reported.y - frame.top) / frame.scale + frame.shift;
    return { top, bottom: top + reported.height / frame.scale - 1 };
}

/**
 * How much of a row must show for Fit Visible Rows to count it on screen,
 * in the grid's pixels, exclusive. One pixel is not enough: the header's
 * bottom border paints over the first pixel below it.
 */
export const VISIBLE_ROW_MIN_PX = 1;

/**
 * The display rows Fit Visible Rows fits: of the rows from `first` down to
 * `last`, stopping at the first below the body, the run whose painted
 * extent overlaps the grid's body (`body`:
 * below the header, above the scroller's bottom edge) by more than
 * `VISIBLE_ROW_MIN_PX`. Glide's own visible range is not used as the
 * answer: it counts the header's height as body and takes a bottom row only
 * past its midpoint, so it can name a row that is off screen and miss one
 * that is partly on it. `span_of` answers undefined for a row the grid has
 * no geometry for.
 */
export function visible_display_rows(
    first: number,
    last: number,
    span_of: (display_row: number) => RowSpan | undefined,
    body: RowSpan,
): DisplayRowInterval | null {
    let start: number | undefined;
    let end: number | undefined;
    for (let row = Math.max(0, first); row <= last; row += 1) {
        const span = span_of(row);
        if (span === undefined) continue;
        // Rows are in order down the grid: the rest are below this one.
        if (span.top >= body.bottom) break;
        const shown = Math.min(span.bottom, body.bottom) - Math.max(span.top, body.top);
        if (shown <= VISIBLE_ROW_MIN_PX) continue;
        start ??= row;
        end = row;
    }
    return start === undefined || end === undefined ? null : { start, end };
}

/**
 * Whether a key press is Fit Visible Rows' shortcut, Shift+Alt+H. Read from
 * the key, or from the physical key when macOS's Option turns H into
 * another character ("Ó"); never while an input method composes or a dead
 * key waits, whose key belongs to the text being composed.
 */
export function is_fit_visible_rows_key(event: {
    readonly key: string;
    readonly code: string;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly isComposing?: boolean;
}): boolean {
    if (!event.shiftKey || !event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.isComposing === true || event.key === 'Process' || event.key === 'Dead') return false;
    if (event.key === 'h' || event.key === 'H') return true;
    // Another layout's letter on this physical key is that letter's shortcut, not this one.
    return event.code === 'KeyH' && !/^[A-Za-z]$/.test(event.key);
}
