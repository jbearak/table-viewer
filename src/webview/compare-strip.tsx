import React from 'react';

export interface CompareStripCounts {
    readonly addedRows: number;
    readonly deletedRows: number;
    readonly movedRows: number;
    readonly changedCells: number;
}

export interface CompareSides {
    readonly originalPath: string;
    readonly modifiedPath: string;
}

export interface CompareStripProps {
    /** The two files, named so the diff colours have an owner. Absent for a
     *  Git SCM diff, where the "original" is a revision rather than a path. */
    readonly sides?: CompareSides;
    readonly counts: CompareStripCounts;
    /** The aligner could not match the rows up and compared by position. */
    readonly degraded: boolean;
    /** Some moves went undetected because the sheet had too many unpaired rows
     *  to score. The counts stand; the move annotation is incomplete. */
    readonly move_search_truncated?: boolean;
    /**
     * Whether anything differs that the row and cell counts do not cover — a
     * renamed promoted header, or a sheet present on only one side. Without it
     * the strip would answer "No differences found" over a grid that is
     * visibly annotating one.
     */
    readonly other_differences?: boolean;
    readonly only_changed_rows: boolean;
    readonly on_toggle_only_changed_rows: (next: boolean) => void;
    /** Filtering is a transform, so it waits like any other. */
    readonly filter_pending?: boolean;
}

/** `1 row` / `2 rows`, so the readout never says "1 rows". */
function plural(count: number, noun: string): string {
    return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What the comparison found, and the one control that acts on it.
 *
 * Workbook state rather than worksheet state — the totals span every sheet —
 * so it sits above the sheet tabs, unlike StateStrip. There is deliberately no
 * "show changes" toggle: in a compare window the diff *is* the document, and
 * turning it off would leave the modified file, which plain Open already shows.
 */
export function CompareStrip({
    sides,
    counts,
    degraded,
    move_search_truncated = false,
    other_differences = false,
    only_changed_rows,
    on_toggle_only_changed_rows,
    filter_pending = false,
}: CompareStripProps): React.JSX.Element {
    // Moved rows count. A file whose only change is reordering would otherwise
    // claim "No differences found." over a grid visibly banding those rows, and
    // leave the filter that would isolate them disabled.
    const no_counted_changes = counts.addedRows === 0
        && counts.deletedRows === 0
        && counts.movedRows === 0
        && counts.changedCells === 0;
    const unchanged = no_counted_changes && !other_differences;
    return (
        <div className="compare-strip">
            {sides && (
                // Which file is which, and why nothing can be edited. Two files
                // under comparison frequently share a basename, and the window
                // title carries only those, so the full paths belong here.
                <div className="compare-strip-sides">
                    <span className="compare-strip-side">
                        <span className="compare-strip-side-mark" aria-hidden="true">−</span>
                        <span className="compare-strip-side-label">Original</span>
                        <span className="compare-strip-side-path" title={sides.originalPath}>
                            {sides.originalPath}
                        </span>
                    </span>
                    <span className="compare-strip-side">
                        <span className="compare-strip-side-mark" aria-hidden="true">+</span>
                        <span className="compare-strip-side-label">Modified</span>
                        <span className="compare-strip-side-path" title={sides.modifiedPath}>
                            {sides.modifiedPath}
                        </span>
                    </span>
                    <span className="compare-strip-readonly">Read-only</span>
                </div>
            )}
            {degraded && (
                // role="status" rather than "alert": it is a caveat about the
                // grid the user is about to read, not an interruption.
                <div className="compare-strip-degraded" role="status">
                    These files were too dissimilar to match up row by row, so rows are
                    compared by position instead. If the rows are in a different order,
                    the differences below will overstate what actually changed.
                </div>
            )}
            {move_search_truncated && (
                // Shown even alongside the degraded notice. Both flags are
                // workbook-wide, so in a multi-sheet workbook they can describe
                // *different* sheets — one compared by position, another
                // aligned fine but with too many rows to check for moves.
                // Suppressing this one whenever any sheet degraded would drop a
                // caveat that is true of a sheet the user is about to read.
                <div className="compare-strip-degraded" role="status">
                    Too many rows differ to check them all for moves, so some rows that
                    only moved are counted as one deleted and one added.
                </div>
            )}
            <div className="compare-strip-row">
                <button
                    type="button"
                    className={`compare-strip-toggle${only_changed_rows ? ' is-on' : ''}`}
                    aria-pressed={only_changed_rows}
                    // Nothing to filter down to when the rows could not be
                    // matched up, or when no row or cell differs.
                    disabled={degraded || no_counted_changes || filter_pending}
                    title={degraded
                        ? 'The rows could not be matched up, so changed rows cannot be singled out.'
                        : no_counted_changes
                            ? 'There are no changed rows to show.'
                            : 'Hide rows that are the same in both files.'}
                    onClick={() => on_toggle_only_changed_rows(!only_changed_rows)}
                >
                    Only changed rows
                </button>
                {/*
                  * A polite status, so a screen reader hears the outcome: the
                  * progress region that was announcing "Comparing…" is gone by
                  * now, and without this its last word on the comparison is
                  * that it had started. The toggle is deliberately outside the
                  * live region — pressing it should announce a control, not
                  * re-read the totals.
                  */}
                <div className="compare-strip-counts" role="status">
                    {degraded
                        // Positional totals are not findings about the files:
                        // a reordered row counts as changed cells it does not
                        // really have, so stating them as such would dress a
                        // failed alignment up as a result.
                        ? 'Rows compared by position'
                        : unchanged
                        ? 'No differences found.'
                        : (
                            <>
                                <span className="compare-strip-added">
                                    +{plural(counts.addedRows, 'row')} added
                                </span>
                                {' · '}
                                <span className="compare-strip-deleted">
                                    −{plural(counts.deletedRows, 'row')} deleted
                                </span>
                                {counts.movedRows > 0 && (
                                    <>
                                        {' · '}
                                        <span className="compare-strip-moved">
                                            {plural(counts.movedRows, 'row')} moved
                                        </span>
                                    </>
                                )}
                                {' · '}
                                <span>{plural(counts.changedCells, 'changed cell')}</span>
                            </>
                        )}
                </div>
            </div>
        </div>
    );
}
