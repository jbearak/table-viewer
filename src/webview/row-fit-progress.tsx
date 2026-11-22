import React, { useEffect, useRef } from 'react';

export interface RowFitProgressProps {
    readonly done: number;
    readonly total: number;
    readonly on_cancel: () => void;
}

/**
 * What the window shows while Auto-fit Rows measures every row.
 *
 * It covers the whole window from the first moment, so nothing can change
 * the rows, the columns or how cells are drawn while they are measured, and
 * nothing is written until the measuring is done. It only becomes visible
 * after a moment (a CSS delay), so a small sheet does not flash it. Focus
 * moves to Cancel, and Escape anywhere on it cancels.
 */
export function RowFitProgress({ done, total, on_cancel }: RowFitProgressProps): React.JSX.Element {
    const cancel_ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        cancel_ref.current?.focus({ preventScroll: true });
    }, []);
    const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    return (
        <div
            className="row-fit-progress"
            role="dialog"
            aria-modal="true"
            aria-label="Auto-fitting rows"
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    on_cancel();
                }
            }}
            onContextMenu={(event) => event.preventDefault()}
        >
            <div className="row-fit-progress-panel" role="status" aria-live="polite">
                <div className="compare-progress-title">Auto-fitting rows…</div>
                <div
                    className="compare-progress-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                    aria-label="Rows measured"
                >
                    <div
                        className="compare-progress-fill"
                        style={{ width: `${(fraction * 100).toFixed(1)}%` }}
                    />
                </div>
                <div className="compare-progress-detail">
                    {`${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows`}
                </div>
                <button
                    ref={cancel_ref}
                    type="button"
                    className="compare-progress-cancel"
                    onClick={on_cancel}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
