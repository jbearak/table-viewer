import React from 'react';

interface SheetTabsProps {
    sheets: string[];
    active_sheet: string;
    on_select: (name: string) => void;
    vertical: boolean;
}

export function SheetTabs({
    sheets,
    active_sheet,
    on_select,
    vertical,
}: SheetTabsProps): React.JSX.Element {
    if (sheets.length <= 1) return <></>;

    const class_name = vertical
        ? 'sheet-tabs-vertical'
        : 'sheet-tabs-horizontal';

    return (
        <div className={class_name}>
            {sheets.map((name) => (
                <button
                    key={name}
                    className={`sheet-tab ${name === active_sheet ? 'active' : ''}`}
                    onClick={() => on_select(name)}
                >
                    {name}
                </button>
            ))}
        </div>
    );
}
