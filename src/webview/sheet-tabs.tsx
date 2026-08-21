import React from 'react';
import type { SheetPairStatus } from '../diff-compare/compare-source';

/**
 * What pressing the orientation control does, named as the destination rather than
 * the current state. Exported because the tab context menu in app.tsx offers the same
 * command and the two must not drift.
 */
export function tab_orientation_label(vertical: boolean): string {
    return vertical
        ? 'Move sheet tabs above the table'
        : 'Move sheet tabs to the left of the table';
}

/** Git compare marker on a tab: the sheet exists on only one side. Derived
 *  from the pairing statuses so the two unions cannot drift. */
export type SheetTabBadge = Exclude<SheetPairStatus, 'matched'>;

export interface SheetTabsProps {
    sheets: string[];
    /** Positional compare badges; absent (or undefined slots) = no badge. */
    badges?: (SheetTabBadge | undefined)[];
    active_sheet_index: number;
    on_select: (sheet_index: number) => void;
    on_context_menu: (sheet_index: number, x: number, y: number) => void;
    /** Sheet actions for a right-click on the strip itself rather than on a tab. */
    on_strip_context_menu: (x: number, y: number) => void;
    on_toggle_orientation: () => void;
    vertical: boolean;
}

export function SheetTabs({
    sheets,
    badges,
    active_sheet_index,
    on_select,
    on_context_menu,
    on_strip_context_menu,
    on_toggle_orientation,
    vertical,
}: SheetTabsProps): React.JSX.Element {
    if (sheets.length <= 1) return <></>;

    const class_name = vertical
        ? 'sheet-tabs-vertical'
        : 'sheet-tabs-horizontal';

    const handle_strip_context_menu = (event: React.MouseEvent<HTMLDivElement>) => {
        // In the vertical arrangement the intrinsic-width track fills the strip's
        // background. Treat its empty space as strip space, while leaving tabs and
        // the orientation control to handle (or ignore) their own context menus.
        if (
            event.target !== event.currentTarget
            && !(event.target instanceof Element
                && event.target.classList.contains('sheet-tabs-vertical-track'))
        ) return;
        event.preventDefault();
        on_strip_context_menu(event.clientX, event.clientY);
    };

    const controls = (
        <>
            {sheets.map((name, index) => (
                <button
                    key={`${index}:${name}`}
                    className={`sheet-tab ${index === active_sheet_index ? 'active' : ''}`}
                    onClick={() => on_select(index)}
                    onContextMenu={(event) => {
                        // Suppress the OS menu; open our sheet actions instead.
                        event.preventDefault();
                        event.stopPropagation();
                        on_context_menu(index, event.clientX, event.clientY);
                    }}
                >
                    {name}
                    {badges?.[index] && (
                        // Visible glyph + spoken word, so the badge is not
                        // color-only: + for a sheet the change added, − for one
                        // it deleted (shown read-only from the original).
                        <span
                            className={`sheet-tab-badge sheet-tab-badge-${badges[index]}`}
                            role="img"
                            aria-label={`(${badges[index]} sheet)`}
                        >
                            {badges[index] === 'added' ? '+' : '−'}
                        </span>
                    )}
                </button>
            ))}
            {/*
              * Tab orientation is a property of this strip, so the control that
              * changes it lives here rather than in the toolbar (#154). It is
              * rendered under the same condition as the tabs themselves — more than
              * one sheet — so it can never be a button with nothing to act on.
              *
              * The label names the destination, not the current state: "Move sheet
              * tabs to the left" says what pressing it does, where "Vertical tabs"
              * left a screen-reader user to infer whether it was a state or an
              * action. Horizontally there is no width to spare, so the text is the
              * accessible name only; in the vertical rail it is shown.
              */}
            <button
                type="button"
                className="sheet-tabs-orientation"
                onClick={on_toggle_orientation}
                aria-label={tab_orientation_label(vertical)}
                title={tab_orientation_label(vertical)}
            >
                <OrientationIcon vertical={vertical} />
                {vertical && <span className="sheet-tabs-orientation-label">Tabs on top</span>}
            </button>
        </>
    );

    return (
        <div
            className={class_name}
            onContextMenu={handle_strip_context_menu}
        >
            <div className={vertical
                ? 'sheet-tabs-track sheet-tabs-vertical-track'
                : 'sheet-tabs-track sheet-tabs-horizontal-track'}
            >
                {controls}
            </div>
        </div>
    );
}

function OrientationIcon({ vertical }: { vertical: boolean }): React.JSX.Element {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden="true"
            focusable="false"
        >
            {vertical
                ? (
                    <>
                        <rect x="1" y="1.5" width="4" height="11" rx="1" />
                        <path d="M7.5 4.5h5M10.5 2.5l2 2-2 2" />
                    </>
                )
                : (
                    <>
                        <rect x="1" y="1.5" width="12" height="3" rx="1" />
                        <rect x="1" y="6.5" width="4" height="6" rx="1" />
                        <path d="M7.5 9.5h5M10.5 7.5l2 2-2 2" />
                    </>
                )}
        </svg>
    );
}
