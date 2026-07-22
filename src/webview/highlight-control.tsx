import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CellHighlightColor } from '../types';
import { CELL_HIGHLIGHT_COLORS, highlight_label, highlight_rgba } from './highlight-theme';
import { use_vscode_theme } from './vscode-theme';

export interface HighlightControlProps {
    active_color: CellHighlightColor;
    on_color_change: (color: CellHighlightColor) => void;
    on_apply: () => void;
    on_clear: () => void;
    selection_available: boolean;
    pending: boolean;
    disabled?: boolean;
    status?: string;
    high_contrast?: boolean;
}

const VIEWPORT_MARGIN_PX = 8;
const POPOVER_GAP_PX = 6;

export function HighlightControl({
    active_color,
    on_color_change,
    on_apply,
    on_clear,
    selection_available,
    pending,
    disabled = false,
    status = '',
    high_contrast: high_contrast_prop,
}: HighlightControlProps): React.JSX.Element {
    const { highContrast: detected_high_contrast } = use_vscode_theme();
    const high_contrast = high_contrast_prop ?? detected_high_contrast;
    const [open, set_open] = useState(false);
    const [popover_style, set_popover_style] = useState<React.CSSProperties>();
    const boundary_ref = useRef<HTMLDivElement>(null);
    const trigger_ref = useRef<HTMLButtonElement>(null);
    const popover_ref = useRef<HTMLDivElement>(null);
    const swatch_refs = useRef<Array<HTMLButtonElement | null>>([]);
    const popover_id = useId();
    const status_id = useId();

    const close = useCallback((restore_focus: boolean) => {
        set_open(false);
        if (restore_focus) trigger_ref.current?.focus();
    }, []);

    useEffect(() => {
        if (disabled) set_open(false);
    }, [disabled]);

    useEffect(() => {
        if (!open) return;
        const active_index = CELL_HIGHLIGHT_COLORS.indexOf(active_color);
        swatch_refs.current[Math.max(0, active_index)]?.focus();
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const pointer = (event: PointerEvent) => {
            if (!boundary_ref.current?.contains(event.target as Node)) close(false);
        };
        const key = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close(true);
        };
        const blur = () => close(false);
        document.addEventListener('pointerdown', pointer, true);
        document.addEventListener('keydown', key, true);
        window.addEventListener('blur', blur);
        return () => {
            document.removeEventListener('pointerdown', pointer, true);
            document.removeEventListener('keydown', key, true);
            window.removeEventListener('blur', blur);
        };
    }, [close, open]);

    useLayoutEffect(() => {
        if (!open) return set_popover_style(undefined);
        const update = () => {
            const trigger = trigger_ref.current;
            const popover = popover_ref.current;
            if (!trigger || !popover) return;
            const t = trigger.getBoundingClientRect();
            const p = popover.getBoundingClientRect();
            const left = Math.min(
                Math.max(t.right - p.width, VIEWPORT_MARGIN_PX),
                Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - p.width - VIEWPORT_MARGIN_PX),
            );
            const below = t.bottom + POPOVER_GAP_PX;
            const above = t.top - p.height - POPOVER_GAP_PX;
            const top = below + p.height <= window.innerHeight - VIEWPORT_MARGIN_PX
                ? below
                : Math.max(VIEWPORT_MARGIN_PX, above);
            set_popover_style({ left, top });
        };
        update();
        window.addEventListener('resize', update);
        document.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            document.removeEventListener('scroll', update, true);
        };
    }, [open]);

    const select_swatch = (index: number) => {
        const normalized = (index + CELL_HIGHLIGHT_COLORS.length)
            % CELL_HIGHLIGHT_COLORS.length;
        on_color_change(CELL_HIGHLIGHT_COLORS[normalized]);
        swatch_refs.current[normalized]?.focus();
    };
    const on_swatch_key_down = (event: React.KeyboardEvent, index: number) => {
        let next: number | undefined;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = CELL_HIGHLIGHT_COLORS.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        select_swatch(next);
    };

    const actions_disabled = disabled || pending || !selection_available;
    return (
        <div ref={boundary_ref} className="toolbar-item highlight-control-anchor">
            <button
                ref={trigger_ref}
                type="button"
                className="toggle highlight-trigger"
                disabled={disabled}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? popover_id : undefined}
                aria-describedby={status ? status_id : undefined}
                onClick={() => set_open((value) => !value)}
            >
                <span
                    className="highlight-trigger-swatch"
                    style={{ background: highlight_rgba(active_color, high_contrast) }}
                    aria-hidden="true"
                />
                Highlight
            </button>
            <span id={status_id} className="sr-only" role="status" aria-live="polite">
                {status}
            </span>
            {open && (
                <div
                    id={popover_id}
                    ref={popover_ref}
                    className="highlight-popover"
                    role="dialog"
                    aria-modal="false"
                    aria-label="Cell highlight controls"
                    style={popover_style}
                >
                    <div className="highlight-swatches" role="radiogroup" aria-label="Highlight color">
                        {CELL_HIGHLIGHT_COLORS.map((color, index) => {
                            const selected = color === active_color;
                            return (
                                <button
                                    key={color}
                                    ref={(element) => { swatch_refs.current[index] = element; }}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    tabIndex={selected ? 0 : -1}
                                    className={`highlight-swatch ${selected ? 'selected' : ''}`}
                                    onClick={() => on_color_change(color)}
                                    onKeyDown={(event) => on_swatch_key_down(event, index)}
                                >
                                    <span
                                        className="highlight-swatch-color"
                                        style={{ background: highlight_rgba(color, high_contrast) }}
                                        aria-hidden="true"
                                    >{selected ? '✓' : ''}</span>
                                    {highlight_label(color)}
                                </button>
                            );
                        })}
                    </div>
                    <div className="highlight-actions">
                        <button
                            type="button"
                            disabled={actions_disabled}
                            onClick={() => { on_apply(); close(true); }}
                        >
                            {pending ? 'Applying…' : 'Apply to selection'}
                        </button>
                        <button
                            type="button"
                            disabled={actions_disabled}
                            onClick={() => { on_clear(); close(true); }}
                        >
                            Clear selection highlights
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
