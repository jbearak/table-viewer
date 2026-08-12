import React, {
    forwardRef,
    useId,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import {
    ColumnVisibilityControl,
    type ColumnVisibilityControlProps,
    type ColumnVisibilityFocusHandle,
} from './column-visibility-control';
import { ContextMenu, type MenuItem } from './context-menu';
import { HighlightControl, type HighlightControlProps } from './highlight-control';

export interface ToolbarFocusHandle {
    focus(): boolean;
    /** Focus the stable Columns trigger used to recover an all-hidden grid. */
    focus_columns(): boolean;
}

/**
 * The all-sheets actions behind a toggle's chevron.
 *
 * One rule holds across every control that has one: the button means this sheet, and
 * the menu holds only all-sheets actions, each naming its action *and* its scope. A
 * lone "Restore original widths" under an "…all 3 sheets" item is unreadable — the
 * reader has to guess whether the omission means "this sheet" or "same as above". And
 * because each of these buttons already toggles in both directions, "this sheet" needs
 * no menu entry: pressing the button is that entry.
 *
 * Absent for a single-sheet workbook, where the chevron could only restate the button.
 */
export interface ToolbarScopeMenu {
    items: readonly {
        label: string;
        on_click: () => void;
        /** Greyed when the action would change nothing — every sheet is already there. */
        disabled?: boolean;
    }[];
    /** Names the menu for assistive tech, e.g. "Auto-fit scope". */
    aria_label: string;
}

export interface ToolbarProps {
    show_formatting: boolean;
    on_toggle_formatting: () => void;
    show_formatting_button: boolean;
    formatting_scope_menu?: ToolbarScopeMenu;
    show_excel_header_button: boolean;
    excel_header_active: boolean;
    excel_header_automatic: boolean;
    excel_header_pending: boolean;
    excel_header_status?: string;
    on_toggle_excel_header: () => void;
    excel_header_disabled?: boolean;
    excel_header_disabled_reason?: string;
    excel_header_scope_menu?: ToolbarScopeMenu;
    column_visibility: ColumnVisibilityControlProps;
    highlight?: HighlightControlProps;
    auto_fit_active: boolean;
    on_toggle_auto_fit: () => void;
    auto_fit_disabled?: boolean;
    auto_fit_disabled_reason?: string;
    auto_fit_scope_menu?: ToolbarScopeMenu;
    edit_mode: boolean;
    is_dirty: boolean;
    on_toggle_edit_mode: () => void;
    show_edit_button: boolean;
    edit_disabled?: boolean;
    edit_disabled_reason?: string;
}

export const Toolbar = forwardRef<ToolbarFocusHandle, ToolbarProps>(function Toolbar(
    props,
    focus_ref,
): React.JSX.Element {
    const toolbar_ref = useRef<HTMLDivElement>(null);
    const columns_ref = useRef<ColumnVisibilityFocusHandle>(null);
    const actions_ref = useRef<HTMLDivElement>(null);
    useImperativeHandle(focus_ref, () => ({
        focus: () => {
            const toolbar = toolbar_ref.current;
            if (!toolbar) return false;
            toolbar.focus({ preventScroll: true });
            return document.activeElement === toolbar;
        },
        focus_columns: () => columns_ref.current?.focus() ?? false,
    }), []);
    // Actions that change something about the whole workbook. Membership here is
    // what puts a button left of the divider; see the action row below.
    const workbook_actions = [
        props.show_edit_button && (
            <ToolbarButton
                key="edit"
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
        ),
        props.show_formatting_button && (
            <ToolbarButton
                key="formatting"
                label="Formatting"
                active={props.show_formatting}
                tooltip_text={props.show_formatting
                    ? 'Show raw cell values on this sheet.'
                    : 'Show formatted cell values on this sheet.'}
                onClick={props.on_toggle_formatting}
                scope_menu={props.formatting_scope_menu}
            />
        ),
    ].filter(Boolean);

    // Actions that change something about the active worksheet only. Columns and
    // Auto-fit are unconditional, so this group never empties — which is why the
    // divider below only has to ask about the workbook group.
    const worksheet_actions = [
        props.show_excel_header_button && (
            <ToolbarButton
                key="excel-header"
                // "Header Row", not "First Row as Header": it was the widest control
                // in the row, and as a toggle the pressed state already supplies the
                // "first row" half of the meaning. "Header" rather than "Names"
                // because it is the word people arrive with — Excel, Power Query and
                // pandas all use it — even though the code sets column *names*. The
                // tooltip carries the precise wording (#164).
                label="Header Row"
                active={props.excel_header_active}
                tooltip_text={props.excel_header_disabled
                    ? (props.excel_header_disabled_reason
                        ?? 'First-row headers are unavailable.')
                    : props.excel_header_active
                    ? props.excel_header_automatic
                        ? 'Automatically using the first row as column names. Click to show it as data.'
                        : 'Show the header row as data on this sheet.'
                    : 'Use the first non-hidden row as column names on this sheet.'}
                onClick={props.on_toggle_excel_header}
                disabled={props.excel_header_disabled}
                focusable_when_disabled
                scope_menu={props.excel_header_scope_menu}
            />
        ),
        <ColumnVisibilityControl
            key="columns"
            ref={columns_ref}
            {...props.column_visibility}
        />,
        <ToolbarButton
            key="auto-fit"
            label="Auto-fit Columns"
            active={props.auto_fit_active}
            tooltip_text={props.auto_fit_disabled
                ? (props.auto_fit_disabled_reason ?? 'Auto-fit is unavailable.')
                : props.auto_fit_active
                ? 'Restore original column widths on this sheet.'
                : 'Auto-fit all columns to their content on this sheet.'}
            onClick={props.on_toggle_auto_fit}
            disabled={props.auto_fit_disabled}
            scope_menu={props.auto_fit_scope_menu}
        />,
    ].filter(Boolean);

    return (
        <div
            ref={toolbar_ref}
            className="toolbar"
            role="toolbar"
            tabIndex={-1}
            aria-label="Table controls"
            onContextMenu={(event) => event.preventDefault()}
        >
            <span className="sr-only" role="status" aria-live="polite">
                {props.excel_header_status ?? ''}
            </span>
            {props.highlight && (
                <div className="toolbar-lead">
                    <HighlightControl {...props.highlight} />
                </div>
            )}
            {/*
              * Two groups: what an action changes for the whole workbook, then what
              * it changes for this worksheet alone. The order used to interleave the
              * two, which read as arbitrary (#154).
              *
              * Built as two arrays rather than as one JSX sequence so that group
              * membership is stated once. The divider follows from whether the
              * workbook group is empty, so adding an action to a group cannot leave
              * the rule behind — the failure that condition would hide is a narrow
              * one, visible only when the new action is the *only* workbook action
              * on screen. Edit alone on the workbook side is the expected state now
              * that tab orientation moved to the sheet tabs (#164), and it still
              * earns the rule: it changes what a keystroke does, not what is shown.
              *
              * Still flat children of one row: `.toolbar-actions > :first-child`
              * carries the right-alignment, so nesting either group in a wrapper
              * would break it.
              */}
            <div ref={actions_ref} className="toolbar-actions">
                {workbook_actions}
                {workbook_actions.length > 0 && (
                    <div
                        className="toolbar-actions-divider"
                        role="separator"
                        aria-orientation="vertical"
                    />
                )}
                {worksheet_actions}
            </div>
        </div>
    );
});

function ToolbarButton({
    label,
    active,
    tooltip_text,
    onClick,
    extra_class,
    disabled = false,
    focusable_when_disabled = false,
    scope_menu,
}: {
    label: string;
    active: boolean;
    tooltip_text: string;
    onClick: () => void;
    extra_class?: string;
    disabled?: boolean;
    focusable_when_disabled?: boolean;
    scope_menu?: ToolbarScopeMenu;
}): React.JSX.Element {
    const [is_hovered, set_is_hovered] = useState(false);
    const [is_focused, set_is_focused] = useState(false);
    const [tooltip_style, set_tooltip_style] = useState<React.CSSProperties>();
    const [menu_coords, set_menu_coords] = useState<{ x: number; y: number } | null>(null);
    const tooltip_id = useId();
    const button_ref = useRef<HTMLButtonElement>(null);
    const caret_ref = useRef<HTMLButtonElement>(null);
    const tooltip_ref = useRef<HTMLDivElement>(null);
    const menu_open = menu_coords !== null;
    // The tooltip would otherwise sit on top of the menu it just opened.
    const show_tooltip = (is_hovered || is_focused) && !menu_open;
    const native_disabled = disabled && !focusable_when_disabled;

    const open_menu = (anchor: HTMLElement | null) => {
        if (!scope_menu || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        set_menu_coords({ x: rect.left, y: rect.bottom + 4 });
    };
    const menu_items: MenuItem[] = (scope_menu?.items ?? []).map((item) => ({
        label: item.label,
        disabled: item.disabled,
        on_click: () => {
            set_menu_coords(null);
            item.on_click();
        },
    }));

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
        const toolbar = button_ref.current?.closest<HTMLElement>('.toolbar');
        const observer = typeof ResizeObserver === 'undefined'
            ? undefined
            : new ResizeObserver(update);
        if (button_ref.current) observer?.observe(button_ref.current);
        if (toolbar) observer?.observe(toolbar);
        document.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        window.visualViewport?.addEventListener('resize', update);
        return () => {
            observer?.disconnect();
            document.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('resize', update);
        };
    }, [show_tooltip]);

    return (
        <div
            className="toolbar-item"
            tabIndex={native_disabled ? 0 : undefined}
            role={native_disabled ? 'group' : undefined}
            aria-label={native_disabled ? label : undefined}
            aria-disabled={native_disabled || undefined}
            aria-describedby={native_disabled && show_tooltip ? tooltip_id : undefined}
            onMouseEnter={() => set_is_hovered(true)}
            onMouseLeave={() => set_is_hovered(false)}
            onFocus={() => set_is_focused(true)}
            onBlur={() => set_is_focused(false)}
            // Right-click anywhere on the control opens the same menu as the chevron,
            // for people who reach for right-click before they look for an affordance.
            onContextMenu={scope_menu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    set_menu_coords({ x: event.clientX, y: event.clientY });
                }
                : undefined}
        >
            <span className={scope_menu
                ? `toolbar-split ${active ? 'active' : ''}`.trim()
                : undefined}
            >
                <button
                    ref={button_ref}
                    type="button"
                    className={`toggle ${active ? 'active' : ''} ${extra_class ?? ''}`.trim()}
                    disabled={native_disabled}
                    aria-disabled={disabled || undefined}
                    onClick={(event) => {
                        if (disabled) return;
                        set_is_hovered(false);
                        if (event.detail > 0) button_ref.current?.blur();
                        onClick();
                    }}
                    aria-describedby={!native_disabled && show_tooltip ? tooltip_id : undefined}
                    aria-pressed={active}
                >
                    {label}
                </button>
                {scope_menu && (
                    <>
                        <span className="toolbar-split-gap" aria-hidden="true" />
                        <button
                            ref={caret_ref}
                            type="button"
                            className={menu_open
                                ? 'toolbar-split-caret open'
                                : 'toolbar-split-caret'}
                            aria-label={scope_menu.aria_label}
                            aria-haspopup="menu"
                            aria-expanded={menu_open}
                            onClick={() => {
                                set_is_hovered(false);
                                if (menu_open) return set_menu_coords(null);
                                open_menu(caret_ref.current);
                            }}
                        >
                            <svg
                                width="9"
                                height="9"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.4"
                                aria-hidden="true"
                                focusable="false"
                            >
                                <path d="M2 4l3 3 3-3" />
                            </svg>
                        </button>
                    </>
                )}
            </span>
            {menu_coords && (
                <ContextMenu
                    x={menu_coords.x}
                    y={menu_coords.y}
                    items={menu_items}
                    aria_label={scope_menu!.aria_label}
                    on_dismiss={() => set_menu_coords(null)}
                    restore_focus={() => caret_ref.current?.focus()}
                />
            )}
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
