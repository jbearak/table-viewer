import React, { forwardRef, useMemo, useRef, useState } from 'react';
import type { FilterValueOption } from '../types';
import { filter_value_label } from './transform-ui-model';

export interface FilterValueChecklistProps {
    /** Complete distinct raw values plus optional display-only labels. */
    values: readonly FilterValueOption[];
    excluded_values: readonly (string | null)[];
    show_labels: boolean;
    on_change: (excluded_values: (string | null)[]) => void;
}

/** Matches the column visibility control's synchronous DOM bound. */
const MAX_RENDERED_OPTIONS = 500;

function option_raw_display(option: FilterValueOption): string {
    return filter_value_label(option.rawValue ?? option.value);
}

function option_display(
    option: FilterValueOption,
    show_labels: boolean,
    duplicate_labels: ReadonlySet<string>,
): string {
    const raw = option_raw_display(option);
    if (show_labels && option.label !== undefined) {
        if (duplicate_labels.has(option.label)) return `${option.label} (${raw})`;
        return option.value !== null && option.label === filter_value_label(null)
            ? `${option.label} (raw ${raw})`
            : option.label;
    }
    return option.value !== null && raw === filter_value_label(null)
        ? `${raw} (text value)`
        : raw;
}

/**
 * Searchable checklist for the "Is one of" filter operator. Checked means the
 * value is NOT excluded. Exclusions persisted for values that no longer occur
 * in the file ("stale") stay listed so they can still be re-checked.
 */
export const FilterValueChecklist = forwardRef<
    HTMLInputElement,
    FilterValueChecklistProps
>(function FilterValueChecklist({
    values,
    excluded_values,
    show_labels,
    on_change,
}, search_ref): React.JSX.Element {
    const [search, set_search] = useState('');
    // The value universe is stable while the popover is open: current column
    // values first, then stale exclusions. Captured once so re-checking a
    // stale exclusion does not reorder or drop it mid-interaction.
    const universe_ref = useRef<FilterValueOption[] | null>(null);
    if (universe_ref.current === null) {
        const known = new Set(values.map((option) => option.value));
        universe_ref.current = [
            ...values,
            ...excluded_values
                .filter((value) => !known.has(value))
                .map((value) => ({ value })),
        ];
    }
    const universe = universe_ref.current;
    const excluded = useMemo(
        () => new Set(excluded_values),
        [excluded_values],
    );
    const duplicate_labels = useMemo(() => {
        if (!show_labels) return new Set<string>();
        const counts = new Map<string, number>();
        for (const option of universe) {
            if (option.label !== undefined) {
                counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
            }
        }
        return new Set(
            [...counts].flatMap(([label, count]) => count > 1 ? [label] : []),
        );
    }, [show_labels, universe]);

    const { rendered, has_more } = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const matches: FilterValueOption[] = [];
        for (const option of universe) {
            const display = option_display(option, show_labels, duplicate_labels);
            const raw = option_raw_display(option);
            if (
                needle.length > 0
                && !`${display}\n${raw}`.toLowerCase().includes(needle)
            ) continue;
            if (matches.length === MAX_RENDERED_OPTIONS) {
                return { rendered: matches, has_more: true };
            }
            matches.push(option);
        }
        return { rendered: matches, has_more: false };
    }, [duplicate_labels, search, show_labels, universe]);

    const toggle = (value: string | null) => {
        const next = new Set(excluded);
        if (next.has(value)) {
            next.delete(value);
        } else {
            next.add(value);
        }
        on_change([...next]);
    };

    return (
        <div className="filter-value-list">
            <input
                ref={search_ref}
                type="search"
                className="filter-value-search"
                aria-label="Search values"
                placeholder="Search values..."
                value={search}
                onChange={(event) => set_search(event.target.value)}
            />
            <div className="filter-value-actions">
                <button
                    type="button"
                    className="filter-value-action"
                    onClick={() => on_change([])}
                >
                    Check all
                </button>
                <button
                    type="button"
                    className="filter-value-action"
                    onClick={() => on_change(universe.map((option) => option.value))}
                >
                    Uncheck all
                </button>
            </div>
            <div className="filter-value-options">
                {rendered.map((option) => {
                    const { value } = option;
                    const checked = !excluded.has(value);
                    const display = option_display(
                        option,
                        show_labels,
                        duplicate_labels,
                    );
                    const raw_display = option_raw_display(option);
                    const accessible_name = value === null
                        ? 'blank values'
                        : show_labels && option.label !== undefined
                            ? `${display}, raw value ${raw_display}`
                            : display;
                    return (
                        <label
                            key={value === null ? 'blank' : `v:${value}`}
                            className="filter-value-item"
                        >
                            <input
                                type="checkbox"
                                checked={checked}
                                aria-label={`${checked ? 'Exclude' : 'Include'} ${accessible_name}`}
                                onChange={() => toggle(value)}
                            />
                            <span className="filter-value-name" title={display}>
                                {display}
                            </span>
                        </label>
                    );
                })}
                {rendered.length === 0 && (
                    <div className="filter-value-empty">
                        No matching values
                    </div>
                )}
                {has_more && (
                    <div className="filter-value-limit" role="status">
                        Showing the first {rendered.length} matches.
                        Refine your search to find other values.
                    </div>
                )}
            </div>
        </div>
    );
});
