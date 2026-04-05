import React from 'react';

interface ToolbarProps {
    show_formatting: boolean;
    on_toggle_formatting: () => void;
    show_formatting_button: boolean;
    vertical_tabs: boolean;
    on_toggle_tab_orientation: () => void;
    show_vertical_tabs_button: boolean;
}

export function Toolbar({
    show_formatting,
    on_toggle_formatting,
    show_formatting_button,
    vertical_tabs,
    on_toggle_tab_orientation,
    show_vertical_tabs_button,
}: ToolbarProps): React.JSX.Element | null {
    if (!show_formatting_button && !show_vertical_tabs_button) return null;

    return (
        <div className="toolbar">
            {show_formatting_button && (
                <button
                    className={`toggle ${show_formatting ? 'active' : ''}`}
                    onClick={on_toggle_formatting}
                    title={show_formatting ? 'Show raw values' : 'Show formatted values'}
                >
                    Formatting
                </button>
            )}
            {show_vertical_tabs_button && (
                <button
                    className={`toggle ${vertical_tabs ? 'active' : ''}`}
                    onClick={on_toggle_tab_orientation}
                    title={vertical_tabs ? 'Horizontal tabs' : 'Vertical tabs'}
                >
                    Vertical Tabs
                </button>
            )}
        </div>
    );
}
