import React from 'react';

interface SheetTabsProps {
    sheets: string[];
    active_sheet_index: number;
    on_select: (sheet_index: number) => void;
    vertical: boolean;
}

export function SheetTabs({
    sheets,
    active_sheet_index,
    on_select,
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
                >
                    {name}
                </button>
            ))}
        </div>
    );
}
