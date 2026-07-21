import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FilterColumnKind, FilterEntry, FilterOperator, HistogramBin } from '../types';
import { FilterHistogram, domain_max, domain_min } from './filter-histogram';
import {
    filter_column_kind_from_histogram,
    filter_draft_for_column,
    filter_options_for_draft,
    is_pristine_default_filter_draft,
    is_range_filter_operator,
    operator_supports_case_sensitive,
} from './transform-ui-model';
import { use_dismiss, type DismissReason } from './use-dismiss';

export type FilterPopoverDismissReason = DismissReason | 'explicit' | 'layout';

export interface FilterPopoverProps {
    column_index: number;
    column_name: string;
    filters: readonly FilterEntry[];
    anchor: { left: number; top: number };
    histogram?: { status: 'loading' }
        | { status: 'ready'; bins: readonly HistogramBin[]; columnKind?: FilterColumnKind }
        | { status: 'error'; message: string };
    on_apply: (entry: FilterEntry) => void;
    on_cancel: (reason: FilterPopoverDismissReason) => void;
}

function preferred_operator_from_histogram(
    histogram: NonNullable<FilterPopoverProps['histogram']>,
): FilterOperator {
    return filter_column_kind_from_histogram(histogram) === 'numeric'
        ? 'between'
        : 'contains';
}

function parse_range_bound(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
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
    const existing = filters.some((entry) => entry.colIndex === column_index);
    const [draft, set_draft] = useState<FilterEntry>(() =>
        filter_draft_for_column(
            column_index,
            filters,
            existing ? 'contains' : preferred_operator_from_histogram(histogram),
        ));
    const [coords, set_coords] = useState(anchor);
    const popover_ref = useRef<HTMLDivElement>(null);
    const first_control_ref = useRef<HTMLSelectElement>(null);
    const layout_dismissed_ref = useRef(false);
    const user_edited_ref = useRef(existing);
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

    // Promote pristine Contains drafts to Between once a numeric histogram arrives.
    useEffect(() => {
        if (existing || user_edited_ref.current) return;
        if (histogram.status !== 'ready' || histogram.bins.length === 0) return;
        set_draft((current) => {
            if (!is_pristine_default_filter_draft(current)) return current;
            return { ...current, operator: 'between' };
        });
    }, [existing, histogram]);

    const needs_value = draft.operator !== 'isEmpty' && draft.operator !== 'isNotEmpty';
    const needs_second = is_range_filter_operator(draft.operator);
    const column_kind = filter_column_kind_from_histogram(histogram);
    const show_case_sensitive = operator_supports_case_sensitive(draft.operator, column_kind);
    const operator_options = filter_options_for_draft(column_kind, draft.operator);
    const can_apply = !needs_value
        || ((draft.value ?? '').length > 0
            && (!needs_second || (draft.secondValue ?? '').length > 0));
    const apply = () => {
        if (!can_apply) return;
        on_apply({ ...draft });
    };

    const update_draft = (next: FilterEntry) => {
        user_edited_ref.current = true;
        set_draft(next);
    };

    const update_range_bounds = (lo: number, hi: number) => {
        user_edited_ref.current = true;
        set_draft((current) => ({
            ...current,
            value: String(lo),
            secondValue: String(hi),
        }));
    };

    const range_lo = parse_range_bound(draft.value);
    const range_hi = parse_range_bound(draft.secondValue);
    const ready_bins = histogram.status === 'ready' ? histogram.bins : null;
    const domain_ready = ready_bins !== null && ready_bins.length > 0;
    // Per-side domain fallback: a single typed bound must survive brushing.
    const raw_histo_lo = domain_ready
        ? (range_lo !== undefined ? range_lo : domain_min(ready_bins))
        : 0;
    const raw_histo_hi = domain_ready
        ? (range_hi !== undefined ? range_hi : domain_max(ready_bins))
        : 0;
    const histo_lo = Math.min(raw_histo_lo, raw_histo_hi);
    const histo_hi = Math.max(raw_histo_lo, raw_histo_hi);

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
                <label className="filter-popover-field-label" htmlFor="filter-condition">
                    Condition
                </label>
                <select
                    ref={first_control_ref}
                    id="filter-condition"
                    className="filter-popover-select"
                    value={draft.operator}
                    onChange={(event) => update_draft({
                        ...draft,
                        operator: event.target.value as FilterOperator,
                    })}
                >
                    {operator_options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
                {needs_value && (
                    <input
                        className="filter-popover-input"
                        aria-label={needs_second ? 'Lower value' : 'Filter value'}
                        placeholder={needs_second ? 'Lower value' : 'Value'}
                        value={draft.value ?? ''}
                        onChange={(event) => update_draft({ ...draft, value: event.target.value })}
                    />
                )}
                {needs_second && (
                    <input
                        className="filter-popover-input"
                        aria-label="Upper value"
                        placeholder="Upper value"
                        value={draft.secondValue ?? ''}
                        onChange={(event) => update_draft({
                            ...draft,
                            secondValue: event.target.value,
                        })}
                    />
                )}
                {needs_second && (
                    <FilterHistogramStatus
                        histogram={histogram}
                        lo={histo_lo}
                        hi={histo_hi}
                        invert_selection={draft.operator === 'notBetween'}
                        on_change={update_range_bounds}
                    />
                )}
                {show_case_sensitive && (
                    <label className="filter-popover-check-row">
                        <input
                            type="checkbox"
                            checked={draft.caseSensitive}
                            onChange={(event) => update_draft({
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

function FilterHistogramStatus({
    histogram,
    lo,
    hi,
    invert_selection = false,
    on_change,
}: {
    histogram: NonNullable<FilterPopoverProps['histogram']>;
    lo: number;
    hi: number;
    invert_selection?: boolean;
    on_change: (lo: number, hi: number) => void;
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
    return (
        <FilterHistogram
            bins={histogram.bins}
            lo={lo}
            hi={hi}
            invert_selection={invert_selection}
            on_change={on_change}
        />
    );
}
