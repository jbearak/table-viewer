import React from 'react';

export interface CompareStripCounts {
    readonly addedRows: number;
    readonly deletedRows: number;
    readonly changedRows: number;
    readonly changedCells: number;
}

export interface CompareStripProps {
    readonly counts: CompareStripCounts;
    /** The aligner could not match the rows up and compared by position. */
    readonly degraded: boolean;
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
    counts,
    degraded,
    other_differences = false,
    only_changed_rows,
    on_toggle_only_changed_rows,
    filter_pending = false,
}: CompareStripProps): React.JSX.Element {
    const no_counted_changes = counts.addedRows === 0
        && counts.deletedRows === 0
        && counts.changedCells === 0;
    const unchanged = no_counted_changes && !other_differences;
    return (
        <div className="compare-strip">
            {degraded && (
                // role="status" rather than "alert": it is a caveat about the
                // grid the user is about to read, not an interruption.
                <div className="compare-strip-degraded" role="status">
                    These files were too dissimilar to match up row by row, so rows are
                    compared by position instead. If the rows are in a different order,
                    the differences below will overstate what actually changed.
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
                <div className="compare-strip-counts">
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
                                {' · '}
                                <span>{plural(counts.changedCells, 'changed cell')}</span>
                            </>
                        )}
                </div>
            </div>
        </div>
    );
}
