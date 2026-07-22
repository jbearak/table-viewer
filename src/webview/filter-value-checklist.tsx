import React, { forwardRef, useMemo, useRef, useState } from 'react';
import { filter_value_label } from './transform-ui-model';

export interface FilterValueChecklistProps {
    /** Complete distinct values for the column; `null` is the blank entry. */
    values: readonly (string | null)[];
    excluded_values: readonly (string | null)[];
    on_change: (excluded_values: (string | null)[]) => void;
}

/** Matches the column visibility control's synchronous DOM bound. */
const MAX_RENDERED_OPTIONS = 500;

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
    on_change,
}, search_ref): React.JSX.Element {
    const [search, set_search] = useState('');
    // The value universe is stable while the popover is open: current column
    // values first, then stale exclusions. Captured once so re-checking a
    // stale exclusion does not reorder or drop it mid-interaction.
    const universe_ref = useRef<(string | null)[] | null>(null);
    if (universe_ref.current === null) {
        const known = new Set(values);
        universe_ref.current = [
            ...values,
            ...excluded_values.filter((value) => !known.has(value)),
        ];
    }
    const universe = universe_ref.current;
    const excluded = useMemo(
        () => new Set(excluded_values),
        [excluded_values],
    );

    const { rendered, has_more } = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const matches: (string | null)[] = [];
        for (const value of universe) {
            if (
                needle.length > 0
                && !filter_value_label(value).toLowerCase().includes(needle)
            ) continue;
            if (matches.length === MAX_RENDERED_OPTIONS) {
                return { rendered: matches, has_more: true };
            }
            matches.push(value);
        }
        return { rendered: matches, has_more: false };
    }, [search, universe]);

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
                    onClick={() => on_change([...universe])}
                >
                    Uncheck all
                </button>
            </div>
            <div className="filter-value-options">
                {rendered.map((value) => {
                    const checked = !excluded.has(value);
                    const label = filter_value_label(value);
                    // A real cell value equal to the blank placeholder must
                    // stay distinguishable from the synthetic blank entry.
                    const display = value !== null && label === filter_value_label(null)
                        ? `${label} (text value)`
                        : label;
                    const accessible_name = value === null ? 'blank values' : display;
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
