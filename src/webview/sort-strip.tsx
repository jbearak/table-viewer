import React, { useRef, useState } from 'react';
import type { SheetTransformState } from '../types';
import { ContextMenu, type MenuItem } from './context-menu';
import { flip_sort, move_sort_first, remove_sort } from './transform-ui-model';

export function SortStrip({
    state,
    column_names,
    disabled,
    on_change,
}: {
    state: SheetTransformState;
    column_names: readonly string[];
    disabled: boolean;
    on_change: (state: SheetTransformState) => void;
}): React.JSX.Element | null {
    if (state.sort.length === 0) return null;
    return (
        <div className="sort-strip" role="group" aria-label="Active sort keys">
            <span className="sort-strip-label">Sort:</span>
            <div className="sort-strip-chips">
                {state.sort.map((key, index) => (
                    <SortChip
                        key={key.colIndex}
                        state={state}
                        index={index}
                        column_name={column_names[key.colIndex] ?? `Column ${key.colIndex + 1}`}
                        disabled={disabled}
                        on_change={on_change}
                    />
                ))}
            </div>
            <button
                type="button"
                className="sort-strip-clear"
                disabled={disabled}
                aria-label="Clear all sorts"
                title="Clear all sorts"
                onClick={() => on_change({ ...state, sort: [] })}
            >
                ✕
            </button>
        </div>
    );
}

function SortChip({
    state,
    index,
    column_name,
    disabled,
    on_change,
}: {
    state: SheetTransformState;
    index: number;
    column_name: string;
    disabled: boolean;
    on_change: (state: SheetTransformState) => void;
}): React.JSX.Element {
    const trigger_ref = useRef<HTMLButtonElement>(null);
    const [coords, set_coords] = useState<{ x: number; y: number } | null>(null);
    const key = state.sort[index];
    const open = coords !== null;
    const menu_items: MenuItem[] = [
        {
            label: 'Flip direction',
            on_click: () => on_change({ ...state, sort: flip_sort(state.sort, index) }),
        },
        {
            label: 'Remove from sort',
            on_click: () => on_change({ ...state, sort: remove_sort(state.sort, index) }),
        },
    ];
    if (state.sort.length > 1) {
        menu_items.push({
            label: 'Move to first',
            disabled: index === 0,
            on_click: () => on_change({ ...state, sort: move_sort_first(state.sort, index) }),
        });
    }
    const toggle = () => {
        if (disabled) return;
        if (open) return set_coords(null);
        const rect = trigger_ref.current?.getBoundingClientRect();
        if (rect) set_coords({ x: rect.left, y: rect.bottom + 4 });
    };
    return (
        <>
            <button
                ref={trigger_ref}
                type="button"
                className={open ? 'sort-chip open' : 'sort-chip'}
                aria-disabled={disabled || undefined}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Sort key ${index + 1}: ${column_name}, ${key.direction === 'asc' ? 'ascending' : 'descending'}. Open actions.`}
                onClick={toggle}
            >
                <span className="sort-chip-name">{column_name}</span>
                <span className="sort-chip-arrow">{key.direction === 'asc' ? '▲' : '▼'}</span>
            </button>
            {coords && (
                <ContextMenu
                    x={coords.x}
                    y={coords.y}
                    items={menu_items}
                    aria_label={`Sort actions for ${column_name}`}
                    on_dismiss={() => set_coords(null)}
                    restore_focus={() => trigger_ref.current?.focus()}
                />
            )}
        </>
    );
}
