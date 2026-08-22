import React from 'react';

export interface CompareProgressProps {
    readonly scannedRows: number;
    readonly totalRows: number;
    readonly on_cancel: () => void;
}

/**
 * What the compare window shows before it has any rows.
 *
 * Alignment is not an optimisation over the diff — it is what makes the diff
 * correct, since comparing row N to row N reports every row below an inserted
 * one as changed. So there is nothing partial worth showing meanwhile, and
 * Cancel closes the window rather than falling back to a positional diff the
 * user did not ask for.
 */
export function CompareProgress({
    scannedRows,
    totalRows,
    on_cancel,
}: CompareProgressProps): React.JSX.Element {
    const fraction = totalRows > 0
        ? Math.min(1, Math.max(0, scannedRows / totalRows))
        : 0;
    return (
        <div className="compare-progress" role="status" aria-live="polite">
            <div className="compare-progress-title">Comparing…</div>
            <div
                className="compare-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={totalRows}
                aria-valuenow={scannedRows}
                aria-label="Aligning rows"
            >
                <div
                    className="compare-progress-fill"
                    style={{ width: `${(fraction * 100).toFixed(1)}%` }}
                />
            </div>
            <div className="compare-progress-detail">
                {`Aligning rows · ${scannedRows.toLocaleString()} of ${totalRows.toLocaleString()}`}
            </div>
            <button type="button" className="compare-progress-cancel" onClick={on_cancel}>
                Cancel
            </button>
        </div>
    );
}
