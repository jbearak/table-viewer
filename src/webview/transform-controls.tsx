import React, { useMemo, useState } from 'react';
import type {
    FilterEntry,
    FilterOperator,
    SheetTransformState,
    SortDirection,
} from '../types';

interface TransformControlsProps {
    state: SheetTransformState;
    column_names: string[];
    disabled: boolean;
    disabled_reason?: string;
    pending: boolean;
    row_count: number;
    source_row_count: number;
    has_merges: boolean;
    on_change: (state: SheetTransformState) => void;
    on_cancel_pending: () => void;
}

const FILTER_OPTIONS: { value: FilterOperator; label: string }[] = [
    { value: 'contains', label: 'Contains' },
    { value: 'notContains', label: 'Does not contain' },
    { value: 'equals', label: 'Equals' },
    { value: 'notEquals', label: 'Does not equal' },
    { value: 'startsWith', label: 'Starts with' },
    { value: 'endsWith', label: 'Ends with' },
    { value: 'greaterThan', label: 'Greater than' },
    { value: 'greaterThanOrEqual', label: 'Greater than or equal' },
    { value: 'lessThan', label: 'Less than' },
    { value: 'lessThanOrEqual', label: 'Less than or equal' },
    { value: 'between', label: 'Between (inclusive)' },
    { value: 'isEmpty', label: 'Is empty' },
    { value: 'isNotEmpty', label: 'Is not empty' },
];

export function TransformControls({
    state,
    column_names,
    disabled,
    disabled_reason,
    pending,
    row_count,
    source_row_count,
    has_merges,
    on_change,
    on_cancel_pending,
}: TransformControlsProps): React.JSX.Element {
    const [editor, set_editor] = useState<'sort' | 'filter' | null>(null);
    const active = state.sort.length > 0
        || state.filters.some((entry) => entry.enabled);
    const controls_disabled = disabled || pending || column_names.length === 0;

    return (
        <div className="transform-controls">
            <div className="transform-controls-row">
                <button
                    type="button"
                    className={`toggle ${state.sort.length > 0 ? 'active' : ''}`}
                    disabled={controls_disabled}
                    title={disabled ? disabled_reason : undefined}
                    onClick={() => set_editor(editor === 'sort' ? null : 'sort')}
                >
                    Sort
                </button>
                <button
                    type="button"
                    className={`toggle ${state.filters.some((entry) => entry.enabled) ? 'active' : ''}`}
                    disabled={controls_disabled}
                    title={disabled ? disabled_reason : undefined}
                    onClick={() => set_editor(editor === 'filter' ? null : 'filter')}
                >
                    Filter
                </button>
                {pending && (
                    <>
                        <span className="transform-pending">Applying…</span>
                        <button
                            type="button"
                            className="transform-clear"
                            onClick={on_cancel_pending}
                        >
                            Cancel
                        </button>
                    </>
                )}
                {disabled && disabled_reason && (
                    <span className="transform-disabled-reason">
                        {disabled_reason}
                    </span>
                )}
                {active && (
                    <span className="transform-row-count">
                        {row_count.toLocaleString()} of {source_row_count.toLocaleString()} rows
                    </span>
                )}
                {active && has_merges && (
                    <span
                        className="transform-merge-notice"
                        title="Merged values remain only in their original top-left cells."
                    >
                        Merged cells shown unmerged; only top-left cells contain values
                    </span>
                )}
            </div>
            {state.sort.length > 0 && (
                <div className="transform-strip" role="group" aria-label="Active sort keys">
                    <span>Sort:</span>
                    {state.sort.map((key, index) => (
                        <div
                            className="transform-chip"
                            key={key.colIndex}
                        >
                            <button
                                type="button"
                                disabled={pending}
                                title="Flip direction"
                                onClick={() => on_change({
                                    ...state,
                                    sort: state.sort.map((candidate, i) => i === index
                                        ? {
                                            ...candidate,
                                            direction: candidate.direction === 'asc' ? 'desc' : 'asc',
                                        }
                                        : candidate),
                                })}
                            >
                                {index + 1}. {column_names[key.colIndex]} {key.direction === 'asc' ? '▲' : '▼'}
                            </button>
                            <button
                                type="button"
                                aria-label={`Remove sort on ${column_names[key.colIndex]}`}
                                disabled={pending}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    on_change({
                                        ...state,
                                        sort: state.sort.filter((_, i) => i !== index),
                                    });
                                }}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        className="transform-clear"
                        disabled={pending}
                        onClick={() => on_change({ ...state, sort: [] })}
                    >
                        Clear sorts
                    </button>
                </div>
            )}
            {state.filters.length > 0 && (
                <div className="transform-strip" role="group" aria-label="Active filters">
                    <span>Filter:</span>
                    {state.filters.map((entry) => (
                        <div
                            className={`transform-chip ${entry.enabled ? '' : 'disabled'}`}
                            key={entry.id}
                        >
                            <button
                                type="button"
                                disabled={pending}
                                onClick={() => on_change({
                                    ...state,
                                    filters: state.filters.map((candidate) =>
                                        candidate.id === entry.id
                                            ? { ...candidate, enabled: !candidate.enabled }
                                            : candidate),
                                })}
                            >
                                {entry.enabled ? '✓' : '✗'} {filter_summary(entry, column_names)}
                            </button>
                            <button
                                type="button"
                                aria-label={`Remove filter on ${column_names[entry.colIndex]}`}
                                disabled={pending}
                                onClick={() => on_change({
                                    ...state,
                                    filters: state.filters.filter((candidate) => candidate.id !== entry.id),
                                })}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        className="transform-clear"
                        disabled={pending}
                        onClick={() => on_change({ ...state, filters: [] })}
                    >
                        Clear filters
                    </button>
                </div>
            )}
            {editor === 'sort' && !controls_disabled && (
                <SortEditor
                    state={state}
                    column_names={column_names}
                    on_apply={(colIndex, direction) => {
                        const existing = state.sort.findIndex((key) => key.colIndex === colIndex);
                        const sort = existing >= 0
                            ? state.sort.map((key, index) => index === existing
                                ? { colIndex, direction }
                                : key)
                            : [...state.sort, { colIndex, direction }];
                        on_change({ ...state, sort });
                        set_editor(null);
                    }}
                    on_cancel={() => set_editor(null)}
                />
            )}
            {editor === 'filter' && !controls_disabled && (
                <FilterEditor
                    column_names={column_names}
                    on_apply={(entry) => {
                        on_change({
                            ...state,
                            filters: [
                                ...state.filters.filter((candidate) =>
                                    candidate.colIndex !== entry.colIndex),
                                entry,
                            ],
                        });
                        set_editor(null);
                    }}
                    on_cancel={() => set_editor(null)}
                />
            )}
        </div>
    );
}

function SortEditor({
    state,
    column_names,
    on_apply,
    on_cancel,
}: {
    state: SheetTransformState;
    column_names: string[];
    on_apply: (colIndex: number, direction: SortDirection) => void;
    on_cancel: () => void;
}): React.JSX.Element {
    const first_available = column_names.findIndex((_, index) =>
        !state.sort.some((key) => key.colIndex === index));
    const [column, set_column] = useState(first_available >= 0 ? first_available : 0);
    const [direction, set_direction] = useState<SortDirection>('asc');
    return (
        <div className="transform-editor" role="dialog" aria-label="Add sort key">
            <label>
                Column
                <select value={column} onChange={(event) => set_column(Number(event.target.value))}>
                    {column_names.map((name, index) => (
                        <option value={index} key={index}>{name}</option>
                    ))}
                </select>
            </label>
            <label>
                Direction
                <select
                    value={direction}
                    onChange={(event) => set_direction(event.target.value as SortDirection)}
                >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                </select>
            </label>
            <button type="button" onClick={() => on_apply(column, direction)}>Apply</button>
            <button type="button" onClick={on_cancel}>Cancel</button>
        </div>
    );
}

function FilterEditor({
    column_names,
    on_apply,
    on_cancel,
}: {
    column_names: string[];
    on_apply: (entry: FilterEntry) => void;
    on_cancel: () => void;
}): React.JSX.Element {
    const [column, set_column] = useState(0);
    const [operator, set_operator] = useState<FilterOperator>('contains');
    const [value, set_value] = useState('');
    const [second_value, set_second_value] = useState('');
    const [case_sensitive, set_case_sensitive] = useState(false);
    const needs_value = operator !== 'isEmpty' && operator !== 'isNotEmpty';
    const can_apply = !needs_value || value.length > 0;
    const id = useMemo(() => new_filter_id(), []);

    return (
        <div className="transform-editor" role="dialog" aria-label="Add filter">
            <label>
                Column
                <select value={column} onChange={(event) => set_column(Number(event.target.value))}>
                    {column_names.map((name, index) => (
                        <option value={index} key={index}>{name}</option>
                    ))}
                </select>
            </label>
            <label>
                Condition
                <select
                    value={operator}
                    onChange={(event) => set_operator(event.target.value as FilterOperator)}
                >
                    {FILTER_OPTIONS.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                </select>
            </label>
            {needs_value && (
                <input
                    aria-label="Filter value"
                    value={value}
                    placeholder="Value"
                    onChange={(event) => set_value(event.target.value)}
                />
            )}
            {operator === 'between' && (
                <input
                    aria-label="Second filter value"
                    value={second_value}
                    placeholder="Upper value"
                    onChange={(event) => set_second_value(event.target.value)}
                />
            )}
            {needs_value && (
                <label className="transform-checkbox">
                    <input
                        type="checkbox"
                        checked={case_sensitive}
                        onChange={(event) => set_case_sensitive(event.target.checked)}
                    />
                    Case sensitive
                </label>
            )}
            <button
                type="button"
                disabled={!can_apply || (operator === 'between' && second_value.length === 0)}
                onClick={() => on_apply({
                    id,
                    colIndex: column,
                    operator,
                    value: needs_value ? value : undefined,
                    secondValue: operator === 'between' ? second_value : undefined,
                    caseSensitive: case_sensitive,
                    enabled: true,
                })}
            >
                Apply
            </button>
            <button type="button" onClick={on_cancel}>Cancel</button>
        </div>
    );
}

function filter_summary(entry: FilterEntry, names: string[]): string {
    const name = names[entry.colIndex] ?? `Column ${entry.colIndex + 1}`;
    const label = FILTER_OPTIONS.find((option) => option.value === entry.operator)?.label
        ?? entry.operator;
    if (entry.operator === 'isEmpty' || entry.operator === 'isNotEmpty') {
        return `${name} ${label.toLocaleLowerCase()}`;
    }
    if (entry.operator === 'between') {
        return `${name} between ${entry.value} and ${entry.secondValue}`;
    }
    return `${name} ${label.toLocaleLowerCase()} “${entry.value}”`;
}

function new_filter_id(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
