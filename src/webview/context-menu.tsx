import React, {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';

export interface ActionMenuItem {
    kind?: 'item';
    label: string;
    on_click: (event: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    checked?: boolean;
    shortcut?: string;
}

export interface SubmenuMenuItem {
    kind: 'submenu';
    label: string;
    items: MenuItem[];
    disabled?: boolean;
}

export interface MenuSeparator { kind: 'separator' }

export type MenuItem = ActionMenuItem | SubmenuMenuItem | MenuSeparator;

type DismissReason = 'outside' | 'scroll' | 'escape' | 'tab' | 'activate';

interface ContextMenuProps {
    x: number;
    y: number;
    items: MenuItem[];
    on_dismiss: () => void;
    restore_focus?: () => void;
    aria_label?: string;
}

interface MenuLevelProps {
    items: MenuItem[];
    aria_label: string;
    dismiss: (reason: DismissReason) => void;
    auto_focus?: boolean;
    on_close?: () => void;
    position?: { left: number; top: number };
    id?: string;
}

function MenuLevel({
    items,
    aria_label,
    dismiss,
    auto_focus = false,
    on_close,
    position,
    id,
}: MenuLevelProps): React.JSX.Element {
    const menu_ref = useRef<HTMLDivElement>(null);
    const trigger_refs = useRef(new Map<number, HTMLButtonElement>());
    const submenu_id_prefix = useId();
    const enabled_indexes = items.flatMap((item, index) =>
        item.kind !== 'separator' && !item.disabled ? [index] : []);
    const [active_index, set_active_index] = useState(enabled_indexes[0] ?? -1);
    const [open_submenu_index, set_open_submenu_index] = useState<number | null>(null);
    const [submenu_position, set_submenu_position] = useState({ left: 0, top: 0 });

    const focus_index = useCallback((index: number) => {
        set_active_index(index);
        trigger_refs.current.get(index)?.focus();
    }, []);

    useEffect(() => {
        if (auto_focus && active_index >= 0) focus_index(active_index);
    }, []);

    useLayoutEffect(() => {
        if (open_submenu_index === null) return;
        const trigger = trigger_refs.current.get(open_submenu_index);
        const child = menu_ref.current?.querySelector<HTMLElement>(
            `[data-parent-menu-index="${open_submenu_index}"] > .context-menu`,
        );
        if (!trigger || !child) return;
        const trigger_rect = trigger.getBoundingClientRect();
        const child_rect = child.getBoundingClientRect();
        const margin = 4;
        const right = trigger_rect.right;
        const left = right + child_rect.width <= window.innerWidth - margin
            ? right
            : Math.max(margin, trigger_rect.left - child_rect.width);
        const top = Math.min(
            Math.max(margin, trigger_rect.top),
            Math.max(margin, window.innerHeight - child_rect.height - margin),
        );
        set_submenu_position((current) => current.left === left && current.top === top
            ? current
            : { left, top });
    }, [open_submenu_index]);

    const move_focus = (direction: 1 | -1 | 'first' | 'last') => {
        if (enabled_indexes.length === 0) return;
        if (direction === 'first') return focus_index(enabled_indexes[0]);
        if (direction === 'last') return focus_index(enabled_indexes[enabled_indexes.length - 1]);
        const current = Math.max(0, enabled_indexes.indexOf(active_index));
        focus_index(enabled_indexes[(current + direction + enabled_indexes.length) % enabled_indexes.length]);
    };

    const open_submenu = (index: number, focus_child: boolean) => {
        const item = items[index];
        if (item?.kind !== 'submenu' || item.disabled) return;
        set_open_submenu_index(index);
        if (focus_child) {
            window.setTimeout(() => {
                menu_ref.current?.querySelector<HTMLElement>(
                    `[data-parent-menu-index="${index}"] [tabindex="0"]`,
                )?.focus();
            }, 0);
        }
    };

    const on_key_down = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const item = items[active_index];
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismiss('escape');
        } else if (event.key === 'Tab') {
            event.stopPropagation();
            dismiss('tab');
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            move_focus(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            move_focus(-1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            event.stopPropagation();
            move_focus('first');
        } else if (event.key === 'End') {
            event.preventDefault();
            event.stopPropagation();
            move_focus('last');
        } else if (
            (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ')
            && item?.kind === 'submenu'
        ) {
            event.preventDefault();
            event.stopPropagation();
            open_submenu(active_index, true);
        } else if (event.key === 'ArrowLeft' && on_close) {
            event.preventDefault();
            event.stopPropagation();
            on_close();
        }
    };

    return (
        <div
            ref={menu_ref}
            id={id}
            className="context-menu"
            style={position}
            role="menu"
            aria-label={aria_label}
            onKeyDown={on_key_down}
        >
            {items.map((item, index) => {
                if (item.kind === 'separator') {
                    return <div key={`separator-${index}`} className="context-menu-divider" role="separator" />;
                }
                if (item.kind === 'submenu') {
                    const is_open = open_submenu_index === index;
                    const submenu_id = `${submenu_id_prefix}-${index}`;
                    return (
                        <React.Fragment key={`${item.label}-${index}`}>
                            <button
                                ref={(element) => {
                                    if (element) trigger_refs.current.set(index, element);
                                    else trigger_refs.current.delete(index);
                                }}
                                data-menu-index={index}
                                type="button"
                                className="context-menu-item"
                                role="menuitem"
                                aria-haspopup="menu"
                                aria-expanded={is_open}
                                aria-controls={submenu_id}
                                disabled={item.disabled}
                                tabIndex={!item.disabled && active_index === index ? 0 : -1}
                                onFocus={() => set_active_index(index)}
                                onPointerEnter={() => open_submenu(index, false)}
                                onMouseEnter={() => open_submenu(index, false)}
                                onClick={() => open_submenu(index, true)}
                            >
                                <span className="context-menu-label">{item.label}</span>
                                <span className="context-menu-submenu-chevron" aria-hidden="true">›</span>
                            </button>
                            {is_open && (
                                <div data-parent-menu-index={index} className="context-menu-submenu-container">
                                    <MenuLevel
                                        items={item.items}
                                        aria_label={`${item.label} submenu`}
                                        dismiss={dismiss}
                                        auto_focus={false}
                                        position={submenu_position}
                                        id={submenu_id}
                                        on_close={() => {
                                            set_open_submenu_index(null);
                                            focus_index(index);
                                        }}
                                    />
                                </div>
                            )}
                        </React.Fragment>
                    );
                }
                return (
                    <button
                        ref={(element) => {
                            if (element) trigger_refs.current.set(index, element);
                            else trigger_refs.current.delete(index);
                        }}
                        key={`${item.label}-${index}`}
                        data-menu-index={index}
                        type="button"
                        className={`context-menu-item${item.checked ? ' active' : ''}`}
                        role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                        aria-checked={item.checked}
                        disabled={item.disabled}
                        tabIndex={!item.disabled && active_index === index ? 0 : -1}
                        onFocus={() => set_active_index(index)}
                        onPointerEnter={() => set_open_submenu_index(null)}
                        onMouseEnter={() => set_open_submenu_index(null)}
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
                );
            })}
        </div>
    );
}

export function ContextMenu({ x, y, items, on_dismiss, restore_focus, aria_label = 'Context menu' }: ContextMenuProps): React.JSX.Element {
    const root_ref = useRef<HTMLDivElement>(null);
    const dismissed_ref = useRef(false);
    const [position, set_position] = useState({ left: x, top: y });

    const dismiss = useCallback((reason: DismissReason) => {
        if (dismissed_ref.current) return;
        dismissed_ref.current = true;
        on_dismiss();
        if (reason === 'escape' || reason === 'activate') {
            window.setTimeout(() => restore_focus?.(), 0);
        }
    }, [on_dismiss, restore_focus]);

    useLayoutEffect(() => {
        const menu = root_ref.current?.firstElementChild as HTMLElement | null;
        if (!menu) return;
        const rect = menu.getBoundingClientRect();
        const margin = 4;
        const left = Math.min(
            Math.max(margin, x),
            Math.max(margin, window.innerWidth - rect.width - margin),
        );
        const top = Math.min(
            Math.max(margin, y),
            Math.max(margin, window.innerHeight - rect.height - margin),
        );
        set_position((current) => current.left === left && current.top === top
            ? current
            : { left, top });
    }, [x, y]);

    useEffect(() => {
        const handle_pointer = (event: PointerEvent) => {
            if (!root_ref.current?.contains(event.target as Node)) dismiss('outside');
        };
        const handle_scroll = (event: Event) => {
            if (!root_ref.current?.contains(event.target as Node)) dismiss('scroll');
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

    return (
        <div ref={root_ref} className="context-menu-root">
            <MenuLevel
                items={items}
                aria_label={aria_label}
                dismiss={dismiss}
                auto_focus
                position={position}
            />
        </div>
    );
}
