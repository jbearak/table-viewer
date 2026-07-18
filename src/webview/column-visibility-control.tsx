import React, {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

export interface ColumnVisibilityOption {
    source_index: number;
    display_name: string;
    source_letter: string;
}

export interface ColumnVisibilityControlProps {
    options: readonly ColumnVisibilityOption[];
    is_visible: (source_index: number) => boolean;
    hidden_count: number;
    reset_key: string;
    on_toggle: (source_index: number) => void;
    on_show_all: () => void;
    on_hide_all: () => void;
    disabled?: boolean;
}

const VIEWPORT_MARGIN_PX = 8;
const POPOVER_GAP_PX = 6;
/** Bound synchronous DOM work for unusually wide CSV/TSV schemas. Search still
 * scans every option, so any source column remains directly reachable. */
const MAX_RENDERED_OPTIONS = 500;

/** Searchable, source-indexed column visibility control for the main toolbar. */
export function ColumnVisibilityControl({
    options,
    is_visible,
    hidden_count,
    reset_key,
    on_toggle,
    on_show_all,
    on_hide_all,
    disabled = false,
}: ColumnVisibilityControlProps): React.JSX.Element {
    const [open, set_open] = useState(false);
    const [filter, set_filter] = useState('');
    const [popover_style, set_popover_style] = useState<React.CSSProperties>();
    const boundary_ref = useRef<HTMLDivElement | null>(null);
    const trigger_ref = useRef<HTMLButtonElement | null>(null);
    const popover_ref = useRef<HTMLDivElement | null>(null);
    const search_ref = useRef<HTMLInputElement | null>(null);
    const popover_id = useId();

    const close = useCallback((restore_focus: boolean) => {
        set_open(false);
        set_filter('');
        if (restore_focus) trigger_ref.current?.focus();
    }, []);

    useEffect(() => {
        set_open(false);
        set_filter('');
    }, [reset_key]);

    useEffect(() => {
        if (open) search_ref.current?.focus();
    }, [open]);

    useEffect(() => {
        if (!open) return;

        const handle_pointer_down = (event: PointerEvent) => {
            const boundary = boundary_ref.current;
            if (boundary?.contains(event.target as Node)) return;
            close(false);
        };
        const handle_key_down = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close(true);
        };
        const handle_blur = () => close(false);

        document.addEventListener('pointerdown', handle_pointer_down, true);
        document.addEventListener('keydown', handle_key_down, true);
        window.addEventListener('blur', handle_blur);
        return () => {
            document.removeEventListener('pointerdown', handle_pointer_down, true);
            document.removeEventListener('keydown', handle_key_down, true);
            window.removeEventListener('blur', handle_blur);
        };
    }, [close, open]);

    useLayoutEffect(() => {
        if (!open) {
            set_popover_style(undefined);
            return;
        }

        const update_position = () => {
            const trigger = trigger_ref.current;
            const popover = popover_ref.current;
            if (!trigger || !popover) return;

            const trigger_rect = trigger.getBoundingClientRect();
            const popover_rect = popover.getBoundingClientRect();
            const viewport_width = window.innerWidth;
            const viewport_height = window.innerHeight;
            const max_left = Math.max(
                VIEWPORT_MARGIN_PX,
                viewport_width - popover_rect.width - VIEWPORT_MARGIN_PX,
            );
            const left = Math.min(
                Math.max(
                    trigger_rect.right - popover_rect.width,
                    VIEWPORT_MARGIN_PX,
                ),
                max_left,
            );

            const below = trigger_rect.bottom + POPOVER_GAP_PX;
            const above = trigger_rect.top - popover_rect.height - POPOVER_GAP_PX;
            const max_top = Math.max(
                VIEWPORT_MARGIN_PX,
                viewport_height - popover_rect.height - VIEWPORT_MARGIN_PX,
            );
            const top = below + popover_rect.height <= viewport_height - VIEWPORT_MARGIN_PX
                ? below
                : above >= VIEWPORT_MARGIN_PX
                    ? above
                    : Math.min(Math.max(below, VIEWPORT_MARGIN_PX), max_top);

            const next_left = `${left}px`;
            const next_top = `${top}px`;
            set_popover_style((current) => (
                current?.left === next_left && current.top === next_top
                    ? current
                    : { left: next_left, top: next_top }
            ));
        };
        const handle_scroll = (event: Event) => {
            if (popover_ref.current?.contains(event.target as Node)) return;
            update_position();
        };

        update_position();
        window.addEventListener('resize', update_position);
        document.addEventListener('scroll', handle_scroll, true);
        window.visualViewport?.addEventListener('resize', update_position);
        return () => {
            window.removeEventListener('resize', update_position);
            document.removeEventListener('scroll', handle_scroll, true);
            window.visualViewport?.removeEventListener('resize', update_position);
        };
    }, [open]);

    const option_is_visible = is_visible;
    const { rendered_options, has_more_matches } = useMemo(() => {
        if (!open) return { rendered_options: [], has_more_matches: false };
        const needle = filter.trim().toLowerCase();
        const matches: ColumnVisibilityOption[] = [];
        for (const option of options) {
            if (
                needle.length > 0
                && !option.display_name.toLowerCase().includes(needle)
                && !option.source_letter.toLowerCase().includes(needle)
            ) continue;
            if (matches.length === MAX_RENDERED_OPTIONS) {
                return { rendered_options: matches, has_more_matches: true };
            }
            matches.push(option);
        }
        return { rendered_options: matches, has_more_matches: false };
    }, [filter, open, options]);
    const trigger_label = hidden_count > 0
        ? `Choose visible columns. ${hidden_count} column${hidden_count === 1 ? '' : 's'} hidden.`
        : 'Choose visible columns.';

    return (
        <div ref={boundary_ref} className="toolbar-item column-visibility-anchor">
            <button
                ref={trigger_ref}
                type="button"
                className={`toggle column-visibility-trigger ${open ? 'active' : ''}`.trim()}
                disabled={disabled}
                aria-label={trigger_label}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? popover_id : undefined}
                onClick={() => {
                    if (open) {
                        close(false);
                    } else {
                        set_open(true);
                    }
                }}
            >
                Columns
                {hidden_count > 0 && (
                    <span className="hidden-count-badge" aria-hidden="true">
                        {hidden_count}
                    </span>
                )}
            </button>
            {open && (
                <div
                    id={popover_id}
                    ref={popover_ref}
                    className="column-visibility-popover"
                    role="dialog"
                    aria-modal="false"
                    aria-label="Choose visible columns"
                    style={popover_style}
                >
                    <input
                        ref={search_ref}
                        type="search"
                        className="column-visibility-search"
                        aria-label="Search columns"
                        placeholder="Search columns..."
                        value={filter}
                        onChange={(event) => set_filter(event.target.value)}
                    />
                    <div className="column-visibility-actions">
                        <button
                            type="button"
                            className="column-visibility-action"
                            onClick={on_show_all}
                        >
                            Show all
                        </button>
                        <button
                            type="button"
                            className="column-visibility-action"
                            onClick={on_hide_all}
                        >
                            Hide all
                        </button>
                    </div>
                    <div className="column-visibility-list">
                        {rendered_options.map((option) => {
                            const visible = option_is_visible(option.source_index);
                            const primary = option.display_name.length > 0
                                ? option.display_name
                                : '(blank)';
                            const source_description = `Column ${option.source_letter} · source ${option.source_index + 1}`;
                            const accessible_name = primary === '(blank)'
                                ? 'blank column'
                                : primary;
                            return (
                                <label
                                    key={option.source_index}
                                    className="column-visibility-item"
                                >
                                    <input
                                        type="checkbox"
                                        checked={visible}
                                        aria-label={`${visible ? 'Hide' : 'Show'} ${accessible_name}; ${source_description}`}
                                        onChange={() => on_toggle(option.source_index)}
                                    />
                                    <span className="column-visibility-name">
                                        {primary}
                                    </span>
                                    <span className="column-visibility-source">
                                        {source_description}
                                    </span>
                                </label>
                            );
                        })}
                        {rendered_options.length === 0 && (
                            <div className="column-visibility-empty">
                                No matching columns
                            </div>
                        )}
                        {has_more_matches && (
                            <div className="column-visibility-limit" role="status">
                                Showing the first {rendered_options.length} matches.
                                Refine your search to find other columns.
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
