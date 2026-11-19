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
import { NEAREST_LIVE_ROW_SCAN_LIMIT, type PendingRowProjection } from './pending-row-projection';

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
 * sorted or filtered view over a layout), so those are read row by row for
 * at most `NEAREST_LIVE_ROW_SCAN_LIMIT` rows, past which an interval is
 * taken to hold one.
 */
export function rows_hold_fit_target(
    projection: Pick<
        PendingRowProjection,
        'layoutMode' | 'nearest_live_display_row' | 'row_state' | 'rowCount' | 'deletedBandStart' | 'pendingBandStart'
    >,
    rows: readonly DisplayRowInterval[],
): boolean {
    for (const interval of rows) {
        const start = Math.max(0, interval.start);
        const end = Math.min(projection.rowCount - 1, interval.end);
        if (start > end) continue;
        if (projection.layoutMode) {
            const live = projection.nearest_live_display_row(start);
            if (live !== undefined && live >= start && live <= end) return true;
            continue;
        }
        if (end >= projection.pendingBandStart) return true;
        const source_end = Math.min(end, projection.deletedBandStart - 1);
        const last = Math.min(source_end, start + NEAREST_LIVE_ROW_SCAN_LIMIT - 1);
        for (let row = start; row <= last; row += 1) {
            const state = projection.row_state(row);
            if (state !== 'removed' && state !== 'tail-removal') return true;
        }
        if (last < source_end) return true;
    }
    return false;
}
