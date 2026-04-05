import React, { useEffect, useRef } from 'react';

export interface MenuItem {
    label: string;
    on_click: () => void;
}

interface ContextMenuProps {
    x: number;
    y: number;
    items: MenuItem[];
    on_dismiss: () => void;
}

export function ContextMenu({
    x,
    y,
    items,
    on_dismiss,
}: ContextMenuProps): React.JSX.Element {
    const menu_ref = useRef<HTMLDivElement>(null);

    // Viewport-clamped positioning
    useEffect(() => {
        const el = menu_ref.current;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = x;
        let top = y;

        if (left + rect.width > vw) {
            left = vw - rect.width - 4;
        }
        if (top + rect.height > vh) {
            top = vh - rect.height - 4;
        }

        el.style.left = `${Math.max(0, left)}px`;
        el.style.top = `${Math.max(0, top)}px`;
    }, [x, y]);

    // Dismiss on outside click
    useEffect(() => {
        const handle_click = (e: MouseEvent) => {
            if (
                menu_ref.current &&
                !menu_ref.current.contains(e.target as Node)
            ) {
                on_dismiss();
            }
        };
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handle_click);
        }, 0);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handle_click);
        };
    }, [on_dismiss]);

    // Dismiss on scroll
    useEffect(() => {
        const handle_scroll = () => on_dismiss();
        document.addEventListener('scroll', handle_scroll, true);
        return () =>
            document.removeEventListener('scroll', handle_scroll, true);
    }, [on_dismiss]);

    return (
        <div
            ref={menu_ref}
            className="context-menu"
            style={{ left: x, top: y }}
        >
            {items.map((item, i) => (
                <div
                    key={i}
                    className="context-menu-item"
                    onClick={() => {
                        item.on_click();
                        on_dismiss();
                    }}
                >
                    {item.label}
                </div>
            ))}
        </div>
    );
}
