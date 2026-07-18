import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export type MenuItem = {
    kind?: 'item';
    label: string;
    on_click: (event: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    checked?: boolean;
    shortcut?: string;
} | {
    kind: 'separator';
};

interface ContextMenuProps {
    x: number;
    y: number;
    items: MenuItem[];
    on_dismiss: () => void;
    restore_focus?: () => void;
    aria_label?: string;
}

export function ContextMenu({
    x,
    y,
    items,
    on_dismiss,
    restore_focus,
    aria_label = 'Context menu',
}: ContextMenuProps): React.JSX.Element {
    const menu_ref = useRef<HTMLDivElement>(null);
    const dismissed_ref = useRef(false);

    const dismiss = useCallback(() => {
        if (dismissed_ref.current) return;
        dismissed_ref.current = true;
        on_dismiss();
        window.setTimeout(() => restore_focus?.(), 0);
    }, [on_dismiss, restore_focus]);

    useEffect(() => {
        const first = menu_ref.current?.querySelector<HTMLButtonElement>(
            'button[role^="menuitem"]:not(:disabled)',
        );
        first?.focus();
    }, []);

    useLayoutEffect(() => {
        const el = menu_ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const margin = 4;
        const left = Math.min(
            Math.max(margin, x),
            Math.max(margin, window.innerWidth - rect.width - margin),
        );
        const top = Math.min(
            Math.max(margin, y),
            Math.max(margin, window.innerHeight - rect.height - margin),
        );
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }, [x, y]);

    useEffect(() => {
        const handle_pointer = (event: PointerEvent) => {
            if (!menu_ref.current?.contains(event.target as Node)) dismiss();
        };
        const handle_scroll = () => dismiss();
        const timer = window.setTimeout(() => {
            document.addEventListener('pointerdown', handle_pointer, true);
            document.addEventListener('scroll', handle_scroll, true);
        }, 0);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener('pointerdown', handle_pointer, true);
            document.removeEventListener('scroll', handle_scroll, true);
        };
    }, [dismiss]);

    const focus_item = (direction: 1 | -1 | 'first' | 'last') => {
        const buttons = Array.from(
            menu_ref.current?.querySelectorAll<HTMLButtonElement>(
                'button[role^="menuitem"]:not(:disabled)',
            ) ?? [],
        );
        if (buttons.length === 0) return;
        if (direction === 'first') return buttons[0].focus();
        if (direction === 'last') return buttons[buttons.length - 1].focus();
        const active = document.activeElement as HTMLButtonElement | null;
        const current = Math.max(0, buttons.indexOf(active!));
        buttons[(current + direction + buttons.length) % buttons.length].focus();
    };

    const on_key_down = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            dismiss();
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            focus_item(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focus_item(-1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            focus_item('first');
        } else if (event.key === 'End') {
            event.preventDefault();
            focus_item('last');
        }
    };

    const activate_item = (
        item: Extract<MenuItem, { kind?: 'item' }>,
        event: React.MouseEvent<HTMLButtonElement>,
    ) => {
        if (item.disabled) return;
        item.on_click(event);
        dismiss();
    };

    return (
        <div
            ref={menu_ref}
            className="context-menu"
            style={{ left: x, top: y }}
            role="menu"
            aria-label={aria_label}
            onKeyDown={on_key_down}
        >
            {items.map((item, index) => item.kind === 'separator' ? (
                <div key={`separator-${index}`} className="context-menu-divider" role="separator" />
            ) : (
                <button
                    key={`${item.label}-${index}`}
                    type="button"
                    className={`context-menu-item${item.checked ? ' active' : ''}`}
                    role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    onClick={(event) => activate_item(item, event)}
                >
                    {item.checked !== undefined && (
                        <span className="context-menu-check">{item.checked ? '✓' : ''}</span>
                    )}
                    <span className="context-menu-label">{item.label}</span>
                    {item.shortcut && (
                        <span className="context-menu-shortcut">{item.shortcut}</span>
                    )}
                </button>
            ))}
        </div>
    );
}
