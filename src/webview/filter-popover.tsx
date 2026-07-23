import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FilterEntry, FilterOperator } from '../types';
import { FilterHistogram, domain_max, domain_min } from './filter-histogram';
import { FilterValueChecklist } from './filter-value-checklist';
import {
    filter_column_kind_from_histogram,
    filter_draft_for_column,
    filter_options_for_draft,
    is_pristine_default_filter_draft,
    is_range_filter_operator,
    operator_supports_case_sensitive,
    type FilterHistogramStatus,
} from './transform-ui-model';
import { use_dismiss, type DismissReason } from './use-dismiss';

export type FilterPopoverDismissReason = DismissReason | 'explicit' | 'layout';

export interface FilterPopoverProps {
    column_index: number;
    column_name: string;
    filters: readonly FilterEntry[];
    anchor: { left: number; top: number };
    histogram?: FilterHistogramStatus;
    on_apply: (entry: FilterEntry) => void;
    on_cancel: (reason: FilterPopoverDismissReason) => void;
    on_remove: () => void;
}

function preferred_operator_from_histogram(
    histogram: NonNullable<FilterPopoverProps['histogram']>,
): FilterOperator {
    if (filter_column_kind_from_histogram(histogram) === 'numeric') return 'between';
    if (histogram.status !== 'ready') return 'contains';
    // Kind may settle as 'unknown' when the host omits it; bins still mean numeric.
    if (histogram.bins.length > 0) return 'between';
    return value_list_offered(histogram) ? 'isOneOf' : 'contains';
}

function value_list_offered(
    histogram: Extract<FilterHistogramStatus, { status: 'ready' }>,
): boolean {
    return histogram.distinctValuesExceeded !== true
        && (histogram.distinctValues?.length ?? 0) > 0;
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
    on_remove,
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
    const condition_ref = useRef<HTMLSelectElement>(null);
    const first_value_ref = useRef<HTMLInputElement>(null);
    const value_search_ref = useRef<HTMLInputElement>(null);
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
        (value_search_ref.current
            ?? first_value_ref.current
            ?? condition_ref.current)?.focus();
    }, []);

    // Promote pristine Contains drafts once the histogram settles: numeric
    // columns get Between, columns with a complete value list get Is one of.
    useEffect(() => {
        if (existing || user_edited_ref.current) return;
        if (histogram.status !== 'ready') return;
        const promoted = preferred_operator_from_histogram(histogram);
        if (promoted === 'contains') return;
        set_draft((current) => {
            if (!is_pristine_default_filter_draft(current)) return current;
            return { ...current, operator: promoted };
        });
        if (promoted === 'isOneOf') {
            // Focus after the checklist mounts.
            window.setTimeout(() => value_search_ref.current?.focus(), 0);
        }
    }, [existing, histogram]);

    const uses_value_list = draft.operator === 'isOneOf';
    const value_list_ready = histogram.status === 'ready'
        && histogram.distinctValuesExceeded !== true;
    const value_list_available = value_list_ready
        && (histogram.distinctValues?.length ?? 0) > 0;
    const needs_value = !uses_value_list
        && draft.operator !== 'isEmpty'
        && draft.operator !== 'isNotEmpty';
    const needs_second = is_range_filter_operator(draft.operator);
    const column_kind = filter_column_kind_from_histogram(histogram);
    const show_case_sensitive = operator_supports_case_sensitive(draft.operator, column_kind);
    const operator_options = filter_options_for_draft(
        column_kind,
        draft.operator,
        value_list_available,
    );
    // An all-checked value list matches every row: applying it would only
    // leave a confusing no-op chip behind. Settled state is required so a
    // late histogram cannot invalidate what the user saw; an over-cap column
    // still lets a saved filter's remaining exclusions be re-applied.
    const can_apply = uses_value_list
        ? histogram.status === 'ready' && (draft.excludedValues?.length ?? 0) > 0
        : !needs_value
            || ((draft.value ?? '').length > 0
                && (!needs_second || (draft.secondValue ?? '').length > 0));
    const apply = () => {
        if (!can_apply) return;
        on_apply({
            ...draft,
            value: uses_value_list ? undefined : draft.value,
            secondValue: uses_value_list ? undefined : draft.secondValue,
            excludedValues: uses_value_list ? draft.excludedValues : undefined,
            caseSensitive: uses_value_list ? false : draft.caseSensitive,
        });
    };

    const update_draft = (next: FilterEntry) => {
        user_edited_ref.current = true;
        set_draft(next);
    };

    const update_operator = (operator: FilterOperator) => {
        // Keep typed inputs and checklist choices in the transient draft so
        // switching operators back and forth before Apply loses nothing.
        update_draft({
            ...draft,
            operator,
            excludedValues: operator === 'isOneOf'
                ? draft.excludedValues ?? []
                : draft.excludedValues,
        });
        if (operator === 'isOneOf') {
            // Focus after the checklist mounts.
            window.setTimeout(() => value_search_ref.current?.focus(), 0);
        }
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
                    || input_type === 'radio'
                    || input_type === 'search';
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
                    ref={condition_ref}
                    id="filter-condition"
                    className="filter-popover-select"
                    value={draft.operator}
                    onChange={(event) =>
                        update_operator(event.target.value as FilterOperator)}
                >
                    {operator_options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
                {uses_value_list && (
                    <FilterValueChecklistStatus
                        histogram={histogram}
                        excluded_values={draft.excludedValues ?? []}
                        search_ref={value_search_ref}
                        on_change={(excluded_values) => update_draft({
                            ...draft,
                            excludedValues: excluded_values,
                        })}
                    />
                )}
                {needs_value && (
                    <input
                        ref={first_value_ref}
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
                {existing && (
                    <button
                        type="button"
                        className="filter-popover-btn filter-popover-btn-danger"
                        onClick={on_remove}
                    >
                        Remove
                    </button>
                )}
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

function FilterValueChecklistStatus({
    histogram,
    excluded_values,
    search_ref,
    on_change,
}: {
    histogram: NonNullable<FilterPopoverProps['histogram']>;
    excluded_values: readonly (string | null)[];
    search_ref: React.RefObject<HTMLInputElement>;
    on_change: (excluded_values: (string | null)[]) => void;
}): React.JSX.Element {
    if (histogram.status === 'loading') {
        return <div className="filter-value-status" role="status">Loading values…</div>;
    }
    if (histogram.status === 'error') {
        return (
            <div className="filter-value-status filter-value-error" role="status">
                Values unavailable: {histogram.message}
            </div>
        );
    }
    if (histogram.distinctValuesExceeded === true) {
        // Only a saved filter can reach this state (new drafts never see the
        // operator). Its stored exclusions stay editable; unchecked values
        // from a partial list are never offered. The checklist stays mounted
        // even once every exclusion is re-checked — its captured universe is
        // what lets that last toggle be undone.
        return (
            <>
                <div className="filter-value-status" role="status">
                    This column has too many distinct values to list.
                    Only previously excluded values are shown.
                </div>
                <FilterValueChecklist
                    ref={search_ref}
                    values={[]}
                    excluded_values={excluded_values}
                    on_change={on_change}
                />
            </>
        );
    }
    return (
        <FilterValueChecklist
            ref={search_ref}
            values={histogram.distinctValues ?? []}
            excluded_values={excluded_values}
            on_change={on_change}
        />
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
