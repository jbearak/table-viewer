import React from 'react';
import type { FilterEntry, SheetTransformState } from '../types';
import { FilterStrip } from './filter-strip';
import { SortStrip } from './sort-strip';

export interface StateStripProps {
    transform: SheetTransformState;
    transform_disabled: boolean;
    transform_pending: boolean;
    transform_progress?: string;
    hidden_rows?: { count: number; pending: boolean; on_unhide_all: () => void };
    column_names: readonly string[];
    merges_flattened: boolean;
    on_transform_change: (state: SheetTransformState) => void;
    on_edit_filter: (entry: FilterEntry, trigger: HTMLElement) => void;
    on_cancel_transform: () => void;
}

/**
 * What is currently altering the view of this worksheet — the active sort keys and
 * filters, the row-hiding count, transform progress, and the merge notice.
 *
 * This is state, not controls, which is why it is a band of its own below the sheet
 * tabs rather than a region of the toolbar (#164). Two consequences worth keeping:
 *
 * - It renders below the tabs because sort and filter are *worksheet* state. Above
 *   them it would sit in the workbook's chrome and contradict itself on every tab
 *   switch, changing its contents from above the control that changed them.
 * - It renders nothing at all when the view is untransformed. A strip that could
 *   appear empty would be chrome the reader learns to skip, and it would cost every
 *   clean sheet a row of height for nothing.
 *
 * Deliberately no "N of M rows" readout. The room is there now, but the count was
 * removed from the toolbar as ambiguous (6622eb7) and the ambiguity is a property of
 * the number, not of where it was shown: with a promoted header row and hidden rows
 * both in play, neither operand names something the reader can point at.
 */
export function StateStrip(props: StateStripProps): React.JSX.Element | null {
    const {
        transform,
        column_names,
        on_transform_change,
        on_edit_filter,
        on_cancel_transform,
    } = props;
    const hidden_count = props.hidden_rows?.count ?? 0;
    const has_state = transform.sort.length > 0
        || transform.filters.length > 0
        || hidden_count > 0
        || props.transform_pending
        || props.merges_flattened;
    if (!has_state) return null;

    const controls_disabled = !!(props.transform_disabled || props.transform_pending);

    return (
        <div className="state-strip" role="group" aria-label="Active view state">
            <SortStrip
                state={transform}
                column_names={column_names}
                disabled={controls_disabled}
                on_change={on_transform_change}
            />
            <FilterStrip
                state={transform}
                column_names={column_names}
                disabled={controls_disabled}
                on_change={on_transform_change}
                on_edit={on_edit_filter}
            />
            {hidden_count > 0 && (
                <div className="filter-chip">
                    <span className="filter-chip-body">
                        {hidden_count} hidden row{hidden_count === 1 ? '' : 's'}
                    </span>
                    <button
                        type="button"
                        className="toolbar-cancel"
                        onClick={props.hidden_rows!.on_unhide_all}
                        disabled={props.hidden_rows!.pending || props.transform_disabled}
                    >
                        Unhide all
                    </button>
                </div>
            )}
            {props.transform_pending && (
                <span className="toolbar-progress" role="status" aria-live="polite">
                    {props.transform_progress ?? 'Applying sort & filters…'}
                </span>
            )}
            {props.transform_pending && (
                <button
                    type="button"
                    className="toolbar-cancel"
                    onClick={on_cancel_transform}
                    // A cancel is itself a transform request, so it belongs behind the
                    // same gate: one the host would refuse would only displace the
                    // request it is trying to cancel.
                    disabled={props.transform_disabled}
                >
                    Cancel
                </button>
            )}
            {props.merges_flattened && (
                <span
                    className="state-strip-merge-notice"
                    title="Merged values remain only in their original top-left cells."
                >
                    Merged cells shown unmerged; only top-left cells contain values
                </span>
            )}
        </div>
    );
}
