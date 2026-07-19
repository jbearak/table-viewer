import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem = {
    kind?: 'item';
    label: string;
    on_click: (event: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    checked?: boolean;
    shortcut?: string;
} | { kind: 'separator' };

type DismissReason = 'outside' | 'scroll' | 'escape' | 'tab' | 'activate';

interface ContextMenuProps {
    x: number;
    y: number;
    items: MenuItem[];
    on_dismiss: () => void;
    restore_focus?: () => void;
    aria_label?: string;
}

export function ContextMenu({ x, y, items, on_dismiss, restore_focus, aria_label = 'Context menu' }: ContextMenuProps): React.JSX.Element {
    const menu_ref = useRef<HTMLDivElement>(null);
    const dismissed_ref = useRef(false);
    const enabled_indexes = items.flatMap((item, index) =>
        item.kind !== 'separator' && !item.disabled ? [index] : []);
    const [active_index, set_active_index] = useState(enabled_indexes[0] ?? -1);
    const [position, set_position] = useState({ left: x, top: y });

    const dismiss = useCallback((reason: DismissReason) => {
        if (dismissed_ref.current) return;
        dismissed_ref.current = true;
        on_dismiss();
        if (reason === 'escape' || reason === 'activate') {
            window.setTimeout(() => restore_focus?.(), 0);
        }
    }, [on_dismiss, restore_focus]);

    const focus_index = useCallback((index: number) => {
        set_active_index(index);
        menu_ref.current?.querySelector<HTMLButtonElement>(`button[data-menu-index="${index}"]`)?.focus();
    }, []);

    useEffect(() => {
        if (active_index >= 0) focus_index(active_index);
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
        set_position((current) => (
            current.left === left && current.top === top ? current : { left, top }
        ));
    }, [x, y]);

    useEffect(() => {
        const handle_pointer = (event: PointerEvent) => {
            if (!menu_ref.current?.contains(event.target as Node)) dismiss('outside');
        };
        const handle_scroll = (event: Event) => {
            if (!menu_ref.current?.contains(event.target as Node)) dismiss('scroll');
        };
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

    const move_focus = (direction: 1 | -1 | 'first' | 'last') => {
        if (enabled_indexes.length === 0) return;
        if (direction === 'first') return focus_index(enabled_indexes[0]);
        if (direction === 'last') return focus_index(enabled_indexes[enabled_indexes.length - 1]);
        const current = Math.max(0, enabled_indexes.indexOf(active_index));
        focus_index(enabled_indexes[(current + direction + enabled_indexes.length) % enabled_indexes.length]);
    };

    const on_key_down = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') { event.preventDefault(); dismiss('escape'); }
        else if (event.key === 'Tab') dismiss('tab');
        else if (event.key === 'ArrowDown') { event.preventDefault(); move_focus(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move_focus(-1); }
        else if (event.key === 'Home') { event.preventDefault(); move_focus('first'); }
        else if (event.key === 'End') { event.preventDefault(); move_focus('last'); }
    };

    return (
        <div ref={menu_ref} className="context-menu" style={position} role="menu" aria-label={aria_label} onKeyDown={on_key_down}>
            {items.map((item, index) => item.kind === 'separator' ? (
                <div key={`separator-${index}`} className="context-menu-divider" role="separator" />
            ) : (
                <button
                    key={`${item.label}-${index}`}
                    data-menu-index={index}
                    type="button"
                    className={`context-menu-item${item.checked ? ' active' : ''}`}
                    role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    tabIndex={!item.disabled && active_index === index ? 0 : -1}
                    onFocus={() => set_active_index(index)}
                    onClick={(event) => {
                        if (item.disabled) return;
                        item.on_click(event);
                        dismiss('activate');
                    }}
                >
                    {item.checked !== undefined && <span className="context-menu-check">{item.checked ? '✓' : ''}</span>}
                    <span className="context-menu-label">{item.label}</span>
                    {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
                </button>
            ))}
        </div>
    );
}
