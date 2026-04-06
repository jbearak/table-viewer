import React, {
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';

interface ToolbarProps {
    show_formatting: boolean;
    on_toggle_formatting: () => void;
    show_formatting_button: boolean;
    vertical_tabs: boolean;
    on_toggle_tab_orientation: () => void;
    show_vertical_tabs_button: boolean;
    auto_fit_active: boolean;
    on_toggle_auto_fit: () => void;
}

export function Toolbar({
    show_formatting,
    on_toggle_formatting,
    show_formatting_button,
    vertical_tabs,
    on_toggle_tab_orientation,
    show_vertical_tabs_button,
    auto_fit_active,
    on_toggle_auto_fit,
}: ToolbarProps): React.JSX.Element {

    return (
        <div className="toolbar">
            {show_formatting_button && (
                <ToolbarButton
                    label="Formatting"
                    active={show_formatting}
                    tooltip_text={
                        show_formatting
                            ? 'Show raw cell values.'
                            : 'Show formatted cell values.'
                    }
                    onClick={on_toggle_formatting}
                />
            )}
            {show_vertical_tabs_button && (
                <ToolbarButton
                    label="Vertical Tabs"
                    active={vertical_tabs}
                    tooltip_text={
                        vertical_tabs
                            ? 'Move sheet tabs above the table.'
                            : 'Move sheet tabs to the left of the table.'
                    }
                    onClick={on_toggle_tab_orientation}
                />
            )}
            <ToolbarButton
                label="Auto-fit Columns"
                active={auto_fit_active}
                tooltip_text={
                    auto_fit_active
                        ? 'Restore original column widths.'
                        : 'Auto-fit all columns to their content.'
                }
                onClick={on_toggle_auto_fit}
            />
        </div>
    );
}

function ToolbarButton({
    label,
    active,
    tooltip_text,
    onClick,
}: {
    label: string;
    active: boolean;
    tooltip_text: string;
    onClick: () => void;
}): React.JSX.Element {
    const [is_hovered, set_is_hovered] = useState(false);
    const [is_focused, set_is_focused] = useState(false);
    const [tooltip_style, set_tooltip_style] = useState<
        React.CSSProperties | undefined
    >(undefined);
    const tooltip_id = useId();
    const button_ref = useRef<HTMLButtonElement | null>(null);
    const tooltip_ref = useRef<HTMLDivElement | null>(null);
    const show_tooltip = is_hovered || is_focused;

    useLayoutEffect(() => {
        if (!show_tooltip) {
            set_tooltip_style(undefined);
            return;
        }

        const update_tooltip_position = () => {
            const button = button_ref.current;
            const tooltip = tooltip_ref.current;
            if (!button || !tooltip) return;

            const viewport_margin = 8;
            const tooltip_gap = 6;
            const button_rect = button.getBoundingClientRect();
            const tooltip_rect = tooltip.getBoundingClientRect();
            const tooltip_width = tooltip_rect.width;
            const viewport_width = window.innerWidth;
            const desired_left =
                button_rect.left + (button_rect.width / 2) - (tooltip_width / 2);
            const max_left = Math.max(
                viewport_margin,
                viewport_width - tooltip_width - viewport_margin
            );
            const left = Math.min(
                Math.max(desired_left, viewport_margin),
                max_left
            );
            const anchor_center = button_rect.left + (button_rect.width / 2);
            const arrow_left = Math.min(
                Math.max(anchor_center - left, 10),
                tooltip_width - 10
            );

            set_tooltip_style({
                left: `${left}px`,
                top: `${button_rect.bottom + tooltip_gap}px`,
                ['--toolbar-tooltip-arrow-left' as '--toolbar-tooltip-arrow-left']:
                    `${arrow_left}px`,
            });
        };

        update_tooltip_position();
        window.addEventListener('resize', update_tooltip_position);
        return () => {
            window.removeEventListener('resize', update_tooltip_position);
        };
    }, [show_tooltip]);

    return (
        <div className="toolbar-item">
            <button
                ref={button_ref}
                type="button"
                className={`toggle ${active ? 'active' : ''}`}
                onClick={onClick}
                onMouseOver={() => set_is_hovered(true)}
                onMouseOut={() => set_is_hovered(false)}
                onFocus={() => set_is_focused(true)}
                onBlur={() => set_is_focused(false)}
                aria-describedby={show_tooltip ? tooltip_id : undefined}
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
