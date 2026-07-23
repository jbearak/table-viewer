import React from 'react';

export interface SheetTabsProps {
    sheets: string[];
    active_sheet_index: number;
    on_select: (sheet_index: number) => void;
    on_context_menu: (sheet_index: number, x: number, y: number) => void;
    vertical: boolean;
}

export function SheetTabs({
    sheets,
    active_sheet_index,
    on_select,
    on_context_menu,
    vertical,
}: SheetTabsProps): React.JSX.Element {
    if (sheets.length <= 1) return <></>;

    const class_name = vertical
        ? 'sheet-tabs-vertical'
        : 'sheet-tabs-horizontal';

    return (
        <div className={class_name}>
            {sheets.map((name, index) => (
                <button
                    key={`${index}:${name}`}
                    className={`sheet-tab ${index === active_sheet_index ? 'active' : ''}`}
                    onClick={() => on_select(index)}
                    onContextMenu={(event) => {
                        // Suppress the OS menu; open our sheet actions instead.
                        event.preventDefault();
                        on_context_menu(index, event.clientX, event.clientY);
                    }}
                >
                    {name}
                </button>
            ))}
        </div>
    );
}
