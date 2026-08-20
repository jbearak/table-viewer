import React, {
    forwardRef,
    useEffect,
    useId,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
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

/**
 * Which scope menu is open, shared across the whole action row.
 *
 * Held here rather than per button for two reasons. A tooltip is suppressed while
 * *any* menu is open, not merely its own button's — otherwise a tooltip left hovering
 * over Formatting stays on screen underneath the menu Header Row just opened, and
 * clicking a caret does not always take focus off the previous one, so the stale
 * tooltip can outlive the hover that created it. And with one source of truth, two
 * menus cannot be open at once.
 */
const ScopeMenuContext = React.createContext<{
    open: { key: string; x: number; y: number } | null;
    set_open: (next: { key: string; x: number; y: number } | null) => void;
} | null>(null);

export interface ToolbarProps {
    /** Called after an action so the owning view can return focus to the grid. */
    on_action_complete: () => void;
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
    const [open_scope_menu, set_open_scope_menu] =
        useState<{ key: string; x: number; y: number } | null>(null);
    const scope_menu_context = useMemo(
        () => ({ open: open_scope_menu, set_open: set_open_scope_menu }),
        [open_scope_menu],
    );
    useImperativeHandle(focus_ref, () => ({
        focus: () => {
            const toolbar = toolbar_ref.current;
            if (!toolbar) return false;
            toolbar.focus({ preventScroll: true });
            return document.activeElement === toolbar;
        },
        focus_columns: () => columns_ref.current?.focus() ?? false,
    }), []);
    // Edit changes how the table behaves rather than how the active worksheet is
    // displayed, so it stands alone to the left of the divider.
    const edit_actions = [
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
                on_action_complete={props.on_action_complete}
                extra_class={props.is_dirty ? 'has-unsaved' : undefined}
                disabled={props.edit_disabled}
            />
        ),
    ].filter(Boolean);

    // Actions that change how the active worksheet is displayed. Columns and
    // Auto-fit are unconditional, so this group never empties.
    const worksheet_actions = [
        props.show_formatting_button && (
            <ToolbarButton
                key="formatting"
                label="Formatting"
                active={props.show_formatting}
                tooltip_text={props.show_formatting
                    ? 'Show raw cell values on this sheet.'
                    : 'Show formatted cell values on this sheet.'}
                onClick={props.on_toggle_formatting}
                on_action_complete={props.on_action_complete}
                menu_key="formatting"
                scope_menu={props.formatting_scope_menu}
            />
        ),
        props.show_excel_header_button && (
            <ToolbarButton
                key="excel-header"
                // "Header Row", not "First Row as Header": it was the widest control
                // in the row, and as a toggle the pressed state already supplies the
                // "first row" half of the meaning. "Header" rather than "Names"
                // because it is the word people arrive with — Excel, Power Query and
                // pandas all use it — even though the code sets column *names*. The
                // tooltip carries the precise wording (#154).
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
                on_action_complete={props.on_action_complete}
                disabled={props.excel_header_disabled}
                focusable_when_disabled
                disabled_split_palette
                menu_key="excel-header"
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
            on_action_complete={props.on_action_complete}
            disabled={props.auto_fit_disabled}
            menu_key="auto-fit"
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
                    <HighlightControl
                        {...props.highlight}
                        on_action_complete={props.on_action_complete}
                    />
                </div>
            )}
            {/*
              * Two groups: Edit mode, then controls for how the worksheet is shown.
              *
              * Built as two arrays rather than as one JSX sequence so that group
              * membership is stated once. The divider follows from whether Edit is
              * present, so it cannot leave a stray leading rule when Edit is hidden.
              *
              * Still flat children of one row: `.toolbar-actions > :first-child`
              * carries the right-alignment, so nesting either group in a wrapper
              * would break it.
              */}
            <ScopeMenuContext.Provider value={scope_menu_context}>
            <div className="toolbar-actions">
                {edit_actions}
                {edit_actions.length > 0 && (
                    <div
                        className="toolbar-actions-divider"
                        role="separator"
                        aria-orientation="vertical"
                    />
                )}
                {worksheet_actions}
            </div>
            </ScopeMenuContext.Provider>
        </div>
    );
});

function ToolbarButton({
    label,
    active,
    tooltip_text,
    onClick,
    on_action_complete,
    extra_class,
    disabled = false,
    focusable_when_disabled = false,
    disabled_split_palette = false,
    menu_key,
    scope_menu,
}: {
    label: string;
    active: boolean;
    tooltip_text: string;
    onClick: () => void;
    on_action_complete: () => void;
    extra_class?: string;
    disabled?: boolean;
    focusable_when_disabled?: boolean;
    disabled_split_palette?: boolean;
    menu_key?: string;
    scope_menu?: ToolbarScopeMenu;
}): React.JSX.Element {
    const [is_hovered, set_is_hovered] = useState(false);
    const [is_focused, set_is_focused] = useState(false);
    const [tooltip_style, set_tooltip_style] = useState<React.CSSProperties>();
    /*
     * Set when a menu item was activated with the pointer.
     *
     * Completing an action now returns focus to the grid. Suppression still matters
     * while the menu closes and that focus handoff is queued: without it, a pointer
     * activation can briefly raise the tooltip over a control the user has finished
     * with. Cleared as soon as the pointer or keyboard comes back.
     */
    const [tooltip_suppressed, set_tooltip_suppressed] = useState(false);
    const scope_context = React.useContext(ScopeMenuContext);
    /*
     * Whether the press that is closing the menu landed on this button's own chevron.
     *
     * `ContextMenu` dismisses from a document-level pointerdown, which lands before
     * the click that press produces. Pressing an open menu's own chevron therefore
     * closed it and then reopened it on the click, so the chevron stuck open instead
     * of toggling.
     *
     * Watching where the press landed, rather than how recently one happened, is what
     * keeps a genuine second press from being swallowed. The listener below merely
     * records — it never acts, so its order against ContextMenu's own listener does
     * not matter.
     */
    const pressed_own_caret_ref = useRef(false);
    // ContextMenu uses the same delayed restore hook for Escape and activation.
    // Remember which one happened so Escape returns to the caret while a completed
    // command returns to the grid.
    const menu_action_activated_ref = useRef(false);
    const tooltip_id = useId();
    const button_ref = useRef<HTMLButtonElement>(null);
    const caret_ref = useRef<HTMLButtonElement>(null);
    const split_ref = useRef<HTMLSpanElement>(null);
    const tooltip_ref = useRef<HTMLDivElement>(null);
    const menu_open = scope_context?.open?.key === menu_key && menu_key !== undefined;
    // Read by the document listener below, which is registered once and so cannot
    // close over the current render's value.
    const menu_open_ref = useRef(menu_open);
    menu_open_ref.current = menu_open;
    // Suppressed while *any* scope menu is open, not merely this button's: a tooltip
    // left hovering over one control would otherwise sit under the menu another just
    // opened, and clicking a caret does not reliably blur the previous one.
    const show_tooltip = (is_hovered || is_focused)
        && !scope_context?.open
        && !tooltip_suppressed;
    const native_disabled = disabled && !focusable_when_disabled;

    /*
     * Forget the hover and focus that were live while the menu was open.
     *
     * Opening the menu with the pointer leaves focus genuinely on the chevron, and
     * dismissing by clicking out in the grid moves it nowhere — a canvas press takes
     * no DOM focus. So the flag is not stale, it is true, and the tooltip suppressed
     * only while the menu was open would spring back over a control the pointer left
     * long ago.
     *
     * Safe for the keyboard path: Escape restores focus to the chevron on a later
     * tick, which sets `is_focused` again and brings the tooltip back, as it should.
     */
    useEffect(() => {
        if (menu_open) return;
        set_is_hovered(false);
        set_is_focused(false);
    }, [menu_open]);

    /*
     * Registered whether or not the menu is open, so the flag is cleared by the next
     * press as reliably as it is set by this one. Scoped to the open menu it would
     * survive a press that produced no click — a drag off the chevron, or a
     * right-click, which reopens the menu through the wrapper's own handler — and
     * that stale `true` would then swallow a later, legitimate open.
     */
    useEffect(() => {
        const record = (event: Event) => {
            pressed_own_caret_ref.current = menu_open_ref.current
                && (caret_ref.current?.contains(event.target as Node) ?? false);
        };
        document.addEventListener('pointerdown', record, true);
        return () => document.removeEventListener('pointerdown', record, true);
    }, []);

    /**
     * Anchor the menu to the left edge of the whole control, not to the chevron.
     *
     * The chevron is the narrow right-hand slice, so anchoring there threw the menu
     * out to the right of the button that owns it and left it looking attached to
     * whatever sat next along the row. Right-click uses the same anchor rather than
     * the pointer, so the menu appears in one predictable place either way.
     */
    const open_menu = () => {
        if (!scope_menu || !menu_key) return;
        const anchor = split_ref.current ?? button_ref.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        scope_context?.set_open({ key: menu_key, x: rect.left, y: rect.bottom + 4 });
    };
    const close_menu = () => scope_context?.set_open(null);

    const menu_items: MenuItem[] = (scope_menu?.items ?? []).map((item) => ({
        label: item.label,
        disabled: item.disabled,
        on_click: (event) => {
            close_menu();
            // `detail` counts clicks: non-zero is a real press, zero is a keyboard
            // activation synthesised as a click. The same idiom the button below uses
            // to decide whether to blur itself.
            if (event.detail > 0) set_tooltip_suppressed(true);
            menu_action_activated_ref.current = true;
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
        <>
            <div
            className="toolbar-item"
            tabIndex={native_disabled ? 0 : undefined}
            role={native_disabled ? 'group' : undefined}
            aria-label={native_disabled ? label : undefined}
            aria-disabled={native_disabled || undefined}
            aria-describedby={native_disabled && show_tooltip ? tooltip_id : undefined}
            onMouseEnter={() => {
                set_is_hovered(true);
                set_tooltip_suppressed(false);
            }}
            onMouseLeave={() => set_is_hovered(false)}
            onFocus={() => set_is_focused(true)}
            onBlur={() => {
                set_is_focused(false);
                set_tooltip_suppressed(false);
            }}
            // Right-click anywhere on the control opens the same menu as the chevron,
            // for people who reach for right-click before they look for an affordance.
            onContextMenu={scope_menu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    open_menu();
                }
                : undefined}
        >
            <span
                ref={split_ref}
                className={scope_menu
                    ? `toolbar-split ${active ? 'active' : ''} ${disabled ? 'disabled' : ''} ${disabled && disabled_split_palette ? 'disabled-palette' : ''}`.trim()
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
                        on_action_complete();
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
                                if (menu_open) return close_menu();
                                // This click's own press is what dismissed the menu:
                                // it was a close, not an open.
                                if (pressed_own_caret_ref.current) {
                                    pressed_own_caret_ref.current = false;
                                    return;
                                }
                                open_menu();
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
            {/*
              * Outside the hover-tracked wrapper, matching every other menu in this
              * webview (sort-strip, filter-strip, column-context-menu). Nested inside
              * it, focus moving into the menu fired no blur and the pointer crossing
              * it fired no mouseleave, so dismissing from elsewhere left both flags
              * stuck on and the tooltip sprang back over a control the pointer had
              * left. The menu positions itself from viewport coordinates, so nothing
              * depends on where it sits in the tree.
              */}
            {menu_open && (
                <ContextMenu
                    x={scope_context!.open!.x}
                    y={scope_context!.open!.y}
                    items={menu_items}
                    aria_label={scope_menu!.aria_label}
                    on_dismiss={close_menu}
                    restore_focus={() => {
                        if (menu_action_activated_ref.current) {
                            menu_action_activated_ref.current = false;
                            on_action_complete();
                        } else {
                            caret_ref.current?.focus();
                        }
                    }}
                />
            )}
        </>
    );
}
