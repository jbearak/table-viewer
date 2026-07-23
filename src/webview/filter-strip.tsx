import React, { useRef, useState } from 'react';
import type { FilterEntry, SheetTransformState } from '../types';
import { ContextMenu, type MenuItem } from './context-menu';
import { filter_summary } from './transform-ui-model';

export function FilterStrip({
    state,
    column_names,
    disabled,
    on_change,
    on_edit,
}: {
    state: SheetTransformState;
    column_names: readonly string[];
    disabled: boolean;
    on_change: (state: SheetTransformState) => void;
    on_edit: (entry: FilterEntry, trigger: HTMLElement) => void;
}): React.JSX.Element | null {
    if (state.filters.length === 0) return null;
    return (
        <div className="filter-strip" role="group" aria-label="Filters">
            <span className="filter-strip-label">Filter:</span>
            <div className="filter-strip-chips">
                {state.filters.map((entry) => (
                    <FilterChip
                        key={entry.id}
                        state={state}
                        entry={entry}
                        column_names={column_names}
                        disabled={disabled}
                        on_change={on_change}
                        on_edit={on_edit}
                    />
                ))}
            </div>
            <button
                type="button"
                className="filter-strip-clear"
                disabled={disabled}
                aria-label="Clear all filters"
                title="Clear all filters"
                onClick={() => on_change({ ...state, filters: [] })}
            >
                ✕
            </button>
        </div>
    );
}

function FilterChip({
    state,
    entry,
    column_names,
    disabled,
    on_change,
    on_edit,
}: {
    state: SheetTransformState;
    entry: FilterEntry;
    column_names: readonly string[];
    disabled: boolean;
    on_change: (state: SheetTransformState) => void;
    on_edit: (entry: FilterEntry, trigger: HTMLElement) => void;
}): React.JSX.Element {
    const body_ref = useRef<HTMLButtonElement>(null);
    const menu_ref = useRef<HTMLButtonElement>(null);
    const suppress_restore_ref = useRef(false);
    const [coords, set_coords] = useState<{ x: number; y: number } | null>(null);
    const summary = filter_summary(entry, column_names);
    const close = () => set_coords(null);
    const open_menu = (x: number, y: number) => {
        if (disabled) return;
        suppress_restore_ref.current = false;
        set_coords({ x, y });
    };
    const edit = (trigger: HTMLElement | null, from_menu = false) => {
        if (disabled) return;
        if (from_menu) suppress_restore_ref.current = true;
        close();
        if (trigger) on_edit(entry, trigger);
    };
    const menu_items: MenuItem[] = [
        { label: 'Edit', on_click: () => edit(menu_ref.current, true) },
        {
            label: entry.enabled ? 'Disable' : 'Enable',
            on_click: () => on_change({
                ...state,
                filters: state.filters.map((candidate) => candidate.id === entry.id
                    ? { ...candidate, enabled: !candidate.enabled }
                    : candidate),
            }),
        },
        {
            label: 'Remove',
            on_click: () => on_change({
                ...state,
                filters: state.filters.filter((candidate) => candidate.id !== entry.id),
            }),
        },
    ];
    return (
        <>
            <div
                className={entry.enabled ? 'filter-chip' : 'filter-chip disabled'}
                onContextMenu={(event) => {
                    // Right-click opens the same actions menu as the kebab, and
                    // always suppresses the OS cut/copy/paste menu.
                    event.preventDefault();
                    open_menu(event.clientX, event.clientY);
                }}
            >
                <span className="filter-chip-toggle" aria-hidden="true">
                    {entry.enabled ? '✓' : '✗'}
                </span>
                <button
                    ref={body_ref}
                    type="button"
                    className="filter-chip-body"
                    aria-disabled={disabled || undefined}
                    aria-label={`Filter: ${summary}. ${entry.enabled ? 'Enabled' : 'Disabled'}. Edit filter.`}
                    onClick={() => edit(body_ref.current)}
                >
                    {summary}
                </button>
                <button
                    ref={menu_ref}
                    type="button"
                    className={coords ? 'filter-chip-kebab open' : 'filter-chip-kebab'}
                    aria-disabled={disabled || undefined}
                    aria-label={`Filter actions for ${summary}`}
                    aria-haspopup="menu"
                    aria-expanded={coords !== null}
                    onClick={() => {
                        if (disabled) return;
                        if (coords) return close();
                        const rect = menu_ref.current?.getBoundingClientRect();
                        if (rect) open_menu(rect.left, rect.bottom + 4);
                    }}
                >
                    ⋯
                </button>
            </div>
            {coords && (
                <ContextMenu
                    x={coords.x}
                    y={coords.y}
                    items={menu_items}
                    aria_label={`Filter actions for ${summary}`}
                    on_dismiss={close}
                    restore_focus={() => {
                        if (!suppress_restore_ref.current) menu_ref.current?.focus();
                    }}
                />
            )}
        </>
    );
}
