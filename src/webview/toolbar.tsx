import React from 'react';

interface ToolbarProps {
    show_formatting: boolean;
    on_toggle_formatting: () => void;
    vertical_tabs: boolean;
    on_toggle_tab_orientation: () => void;
}

export function Toolbar({
    show_formatting,
    on_toggle_formatting,
    vertical_tabs,
    on_toggle_tab_orientation,
}: ToolbarProps): React.JSX.Element {
    return (
        <div className="toolbar">
            <button
                className={`toggle ${show_formatting ? 'active' : ''}`}
                onClick={on_toggle_formatting}
                title={show_formatting ? 'Show raw values' : 'Show formatted values'}
            >
                Formatting
            </button>
            <button
                className={`toggle ${vertical_tabs ? 'active' : ''}`}
                onClick={on_toggle_tab_orientation}
                title={vertical_tabs ? 'Horizontal tabs' : 'Vertical tabs'}
            >
                Vertical Tabs
            </button>
        </div>
    );
}
