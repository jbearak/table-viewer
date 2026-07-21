import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FilterEntry, FilterOperator, HistogramBin } from '../types';
import { FILTER_OPTIONS, filter_draft_for_column } from './transform-ui-model';
import { use_dismiss, type DismissReason } from './use-dismiss';

export type FilterPopoverDismissReason = DismissReason | 'explicit' | 'layout';

export interface FilterPopoverProps {
    column_index: number;
    column_name: string;
    filters: readonly FilterEntry[];
    anchor: { left: number; top: number };
    histogram?: { status: 'loading' }
        | { status: 'ready'; bins: readonly HistogramBin[] }
        | { status: 'error'; message: string };
    on_apply: (entry: FilterEntry) => void;
    on_cancel: (reason: FilterPopoverDismissReason) => void;
}

export function FilterPopover({
    column_index,
    column_name,
    filters,
    anchor,
    histogram = { status: 'loading' },
    on_apply,
    on_cancel,
}: FilterPopoverProps): React.JSX.Element {
    const [draft, set_draft] = useState<FilterEntry>(() =>
        filter_draft_for_column(column_index, filters));
    const [coords, set_coords] = useState(anchor);
    const popover_ref = useRef<HTMLDivElement>(null);
    const first_control_ref = useRef<HTMLSelectElement>(null);
    const layout_dismissed_ref = useRef(false);
    use_dismiss(popover_ref, on_cancel);

    useLayoutEffect(() => {
        const update_position = () => {
            const element = popover_ref.current;
            if (!element) return;
            const margin = 8;
            const rect = element.getBoundingClientRect();
            const next = {
                left: Math.min(
                    Math.max(margin, anchor.left),
                    Math.max(margin, window.innerWidth - rect.width - margin),
                ),
                top: Math.min(
                    Math.max(margin, anchor.top),
                    Math.max(margin, window.innerHeight - rect.height - margin),
                ),
            };
            set_coords((current) => current.left === next.left && current.top === next.top
                ? current
                : next);
        };
        update_position();
        const observer = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(update_position);
        if (popover_ref.current) observer?.observe(popover_ref.current);
        return () => observer?.disconnect();
    }, [anchor.left, anchor.top, draft.operator]);

    useEffect(() => {
        const dismiss_for_layout = (event: Event) => {
            if (
                event.type === 'scroll'
                && event.target instanceof Node
                && popover_ref.current?.contains(event.target)
            ) return;
            if (layout_dismissed_ref.current) return;
            layout_dismissed_ref.current = true;
            on_cancel('layout');
        };
        window.addEventListener('resize', dismiss_for_layout);
        window.addEventListener('scroll', dismiss_for_layout, true);
        document.addEventListener('scroll', dismiss_for_layout, true);
        window.visualViewport?.addEventListener('resize', dismiss_for_layout);
        return () => {
            window.removeEventListener('resize', dismiss_for_layout);
            window.removeEventListener('scroll', dismiss_for_layout, true);
            document.removeEventListener('scroll', dismiss_for_layout, true);
            window.visualViewport?.removeEventListener('resize', dismiss_for_layout);
        };
    }, [on_cancel]);

    useEffect(() => {
        first_control_ref.current?.focus();
    }, []);

    const needs_value = draft.operator !== 'isEmpty' && draft.operator !== 'isNotEmpty';
    const needs_second = draft.operator === 'between';
    const can_apply = !needs_value
        || ((draft.value ?? '').length > 0
            && (!needs_second || (draft.secondValue ?? '').length > 0));
    const apply = () => {
        if (!can_apply) return;
        on_apply({ ...draft });
    };

    return (
        <div
            ref={popover_ref}
            className="filter-popover"
            role="dialog"
            aria-label={`Filter on ${column_name}`}
            style={{ left: coords.left, top: coords.top }}
            onKeyDown={(event) => {
                const target = event.target;
                const input_type = target instanceof HTMLInputElement
                    ? target.type.toLowerCase()
                    : '';
                const native_control_handles_enter =
                    target instanceof HTMLButtonElement
                    || target instanceof HTMLSelectElement
                    || input_type === 'checkbox'
                    || input_type === 'radio';
                if (
                    event.key === 'Enter'
                    && can_apply
                    && !native_control_handles_enter
                    && !event.nativeEvent.isComposing
                ) {
                    event.preventDefault();
                    apply();
                }
            }}
        >
            <div className="filter-popover-header">
                <span className="filter-popover-colname">{column_name}</span>
            </div>
            <div className="filter-popover-body">
                <FilterHistogram histogram={histogram} />
                <label className="filter-popover-field-label" htmlFor="filter-condition">
                    Condition
                </label>
                <select
                    ref={first_control_ref}
                    id="filter-condition"
                    className="filter-popover-select"
                    value={draft.operator}
                    onChange={(event) => set_draft({
                        ...draft,
                        operator: event.target.value as FilterOperator,
                    })}
                >
                    {FILTER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
                {needs_value && (
                    <input
                        className="filter-popover-input"
                        aria-label="Filter value"
                        placeholder="Value"
                        value={draft.value ?? ''}
                        onChange={(event) => set_draft({ ...draft, value: event.target.value })}
                    />
                )}
                {needs_second && (
                    <input
                        className="filter-popover-input"
                        aria-label="Second filter value"
                        placeholder="Upper value"
                        value={draft.secondValue ?? ''}
                        onChange={(event) => set_draft({
                            ...draft,
                            secondValue: event.target.value,
                        })}
                    />
                )}
                {needs_value && (
                    <label className="filter-popover-check-row">
                        <input
                            type="checkbox"
                            checked={draft.caseSensitive}
                            onChange={(event) => set_draft({
                                ...draft,
                                caseSensitive: event.target.checked,
                            })}
                        />
                        Case sensitive
                    </label>
                )}
            </div>
            <div className="filter-popover-footer">
                <button
                    type="button"
                    className="filter-popover-btn filter-popover-btn-primary"
                    disabled={!can_apply}
                    onClick={apply}
                >
                    Apply
                </button>
                <button type="button" className="filter-popover-btn" onClick={() => on_cancel('explicit')}>
                    Cancel
                </button>
            </div>
        </div>
    );
}

function FilterHistogram({
    histogram,
}: {
    histogram: NonNullable<FilterPopoverProps['histogram']>;
}): React.JSX.Element {
    if (histogram.status === 'loading') {
        return <div className="filter-histogram-status" role="status">Loading distribution…</div>;
    }
    if (histogram.status === 'error') {
        return (
            <div className="filter-histogram-status filter-histogram-error" role="status">
                Distribution unavailable: {histogram.message}
            </div>
        );
    }
    if (histogram.bins.length === 0) {
        return (
            <div className="filter-histogram-status" role="status">
                No numeric values to chart.
            </div>
        );
    }
    const max_count = Math.max(1, ...histogram.bins.map((bin) => bin.count));
    const total = histogram.bins.reduce((sum, bin) => sum + bin.count, 0);
    return (
        <div
            className="filter-histogram"
            role="img"
            aria-label={`Distribution of ${total} numeric values from ${histogram.bins[0].lo} to ${histogram.bins.at(-1)!.hi}`}
        >
            {histogram.bins.map((bin, index) => (
                <span
                    key={`${bin.lo}:${bin.hi}:${index}`}
                    className="filter-histogram-bar"
                    style={{
                        height: bin.count === 0
                            ? '0%'
                            : `${Math.max(2, (bin.count / max_count) * 100)}%`,
                    }}
                    title={`${bin.lo} – ${bin.hi}: ${bin.count}`}
                />
            ))}
        </div>
    );
}
