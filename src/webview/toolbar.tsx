import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import type { FilterEntry, SheetTransformState } from '../types';
import {
    ColumnVisibilityControl,
    type ColumnVisibilityControlProps,
} from './column-visibility-control';
import { FilterStrip } from './filter-strip';
import { SortStrip } from './sort-strip';
import { use_toolbar_wrap } from './use-toolbar-wrap';

export interface ToolbarProps {
    row_count: number;
    source_row_count: number;
    transform: SheetTransformState;
    transform_disabled: boolean;
    transform_pending: boolean;
    transform_progress?: string;
    column_names: readonly string[];
    merges_flattened: boolean;
    on_transform_change: (state: SheetTransformState) => void;
    on_edit_filter: (entry: FilterEntry, trigger: HTMLElement) => void;
    on_cancel_transform: () => void;
    show_formatting: boolean;
    on_toggle_formatting: () => void;
    show_formatting_button: boolean;
    vertical_tabs: boolean;
    on_toggle_tab_orientation: () => void;
    show_vertical_tabs_button: boolean;
    column_visibility: ColumnVisibilityControlProps;
    auto_fit_active: boolean;
    on_toggle_auto_fit: () => void;
    auto_fit_disabled?: boolean;
    auto_fit_disabled_reason?: string;
    edit_mode: boolean;
    is_dirty: boolean;
    on_toggle_edit_mode: () => void;
    show_edit_button: boolean;
    edit_disabled?: boolean;
    edit_disabled_reason?: string;
}

export function Toolbar(props: ToolbarProps): React.JSX.Element {
    const {
        transform,
        row_count,
        source_row_count,
        column_names,
        on_transform_change,
        on_edit_filter,
        on_cancel_transform,
    } = props;
    const toolbar_ref = useRef<HTMLDivElement>(null);
    const lead_ref = useRef<HTMLSpanElement>(null);
    const chips_ref = useRef<HTMLDivElement>(null);
    const actions_ref = useRef<HTMLDivElement>(null);
    const row_count_text = row_count === source_row_count
        ? `${row_count.toLocaleString()} rows`
        : `${row_count.toLocaleString()} of ${source_row_count.toLocaleString()} rows`;
    const wrapped = use_toolbar_wrap(
        { toolbar: toolbar_ref, lead: lead_ref, chips: chips_ref, actions: actions_ref },
        [
            transform.sort,
            transform.filters,
            row_count_text,
            props.transform_pending,
            props.merges_flattened,
            props.column_visibility.hidden_columns.length,
            props.show_formatting_button,
            props.show_vertical_tabs_button,
            props.show_edit_button,
        ],
    );
    const controls_disabled = !!(props.transform_disabled || props.transform_pending);

    return (
        <div ref={toolbar_ref} className={wrapped ? 'toolbar is-wrapped' : 'toolbar'}>
            <span ref={lead_ref} className="toolbar-row-count">{row_count_text}</span>
            <div ref={chips_ref} className="toolbar-chips">
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
                    >
                        Cancel
                    </button>
                )}
                {props.merges_flattened && (
                    <span
                        className="toolbar-merge-notice"
                        title="Merged values remain only in their original top-left cells."
                    >
                        Merged cells shown unmerged; only top-left cells contain values
                    </span>
                )}
            </div>
            <div ref={actions_ref} className="toolbar-actions">
                {props.show_formatting_button && (
                    <ToolbarButton
                        label="Formatting"
                        active={props.show_formatting}
                        tooltip_text={props.show_formatting
                            ? 'Show raw cell values.'
                            : 'Show formatted cell values.'}
                        onClick={props.on_toggle_formatting}
                    />
                )}
                {props.show_vertical_tabs_button && (
                    <ToolbarButton
                        label="Vertical Tabs"
                        active={props.vertical_tabs}
                        tooltip_text={props.vertical_tabs
                            ? 'Move sheet tabs above the table.'
                            : 'Move sheet tabs to the left of the table.'}
                        onClick={props.on_toggle_tab_orientation}
                    />
                )}
                <ColumnVisibilityControl {...props.column_visibility} />
                <ToolbarButton
                    label="Auto-fit Columns"
                    active={props.auto_fit_active}
                    tooltip_text={props.auto_fit_disabled
                        ? (props.auto_fit_disabled_reason ?? 'Auto-fit is unavailable.')
                        : props.auto_fit_active
                        ? 'Restore original column widths.'
                        : 'Auto-fit all columns to their content.'}
                    onClick={props.on_toggle_auto_fit}
                    disabled={props.auto_fit_disabled}
                />
                {props.show_edit_button && (
                    <ToolbarButton
                        label="Edit"
                        active={props.edit_mode}
                        tooltip_text={props.edit_disabled
                            ? (props.edit_disabled_reason ?? 'Editing is unavailable.')
                            : props.edit_mode
                            ? 'Exit edit mode.'
                            : 'Enter edit mode to modify cell values.'}
                        onClick={props.on_toggle_edit_mode}
                        extra_class={props.is_dirty ? 'has-unsaved' : undefined}
                        disabled={props.edit_disabled}
                    />
                )}
            </div>
        </div>
    );
}

function ToolbarButton({
    label,
    active,
    tooltip_text,
    onClick,
    extra_class,
    disabled = false,
}: {
    label: string;
    active: boolean;
    tooltip_text: string;
    onClick: () => void;
    extra_class?: string;
    disabled?: boolean;
}): React.JSX.Element {
    const [is_hovered, set_is_hovered] = useState(false);
    const [is_focused, set_is_focused] = useState(false);
    const [tooltip_style, set_tooltip_style] = useState<React.CSSProperties>();
    const tooltip_id = useId();
    const button_ref = useRef<HTMLButtonElement>(null);
    const tooltip_ref = useRef<HTMLDivElement>(null);
    const show_tooltip = is_hovered || is_focused;

    useLayoutEffect(() => {
        if (!show_tooltip) return set_tooltip_style(undefined);
        const update = () => {
            const button = button_ref.current;
            const tooltip = tooltip_ref.current;
            if (!button || !tooltip) return;
            const button_rect = button.getBoundingClientRect();
            const tooltip_width = tooltip.getBoundingClientRect().width;
            const left = Math.min(
                Math.max(button_rect.left + button_rect.width / 2 - tooltip_width / 2, 8),
                Math.max(8, window.innerWidth - tooltip_width - 8),
            );
            set_tooltip_style({
                left,
                top: button_rect.bottom + 6,
                '--toolbar-tooltip-arrow-left': `${Math.min(Math.max(button_rect.left + button_rect.width / 2 - left, 10), tooltip_width - 10)}px`,
            } as React.CSSProperties);
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, [show_tooltip]);

    return (
        <div
            className="toolbar-item"
            tabIndex={disabled ? 0 : undefined}
            role={disabled ? 'group' : undefined}
            aria-label={disabled ? label : undefined}
            aria-disabled={disabled || undefined}
            aria-describedby={disabled && show_tooltip ? tooltip_id : undefined}
            onMouseEnter={() => set_is_hovered(true)}
            onMouseLeave={() => set_is_hovered(false)}
            onFocus={() => set_is_focused(true)}
            onBlur={() => set_is_focused(false)}
        >
            <button
                ref={button_ref}
                type="button"
                className={`toggle ${active ? 'active' : ''} ${extra_class ?? ''}`.trim()}
                disabled={disabled}
                onClick={(event) => {
                    set_is_hovered(false);
                    if (event.nativeEvent instanceof PointerEvent) button_ref.current?.blur();
                    onClick();
                }}
                aria-describedby={!disabled && show_tooltip ? tooltip_id : undefined}
            >
                {label}
            </button>
            {show_tooltip && (
                <div
                    id={tooltip_id}
                    ref={tooltip_ref}
                    role="tooltip"
                    className="toolbar-tooltip"
                    style={tooltip_style}
                >
                    {tooltip_text}
                </div>
            )}
        </div>
    );
}
