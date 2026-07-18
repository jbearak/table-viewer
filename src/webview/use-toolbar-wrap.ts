import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const WRAP_HYSTERESIS_PX = 8;
const TOOLBAR_GAP_PX = 8;
const TOOLBAR_ACTION_GAP_PX = 6;

export interface ToolbarPartWidths {
    lead_px: number;
    chips_px: number;
    actions_px: number;
}

export function should_wrap(
    parts: ToolbarPartWidths,
    available_px: number,
    gap_px: number,
    was_wrapped: boolean,
): boolean {
    if (parts.chips_px <= 0) return false;
    const widths = [parts.lead_px, parts.chips_px, parts.actions_px]
        .filter((width) => width > 0);
    const needed = widths.reduce((sum, width) => sum + width, 0)
        + Math.max(0, widths.length - 1) * gap_px;
    const threshold = was_wrapped
        ? available_px - WRAP_HYSTERESIS_PX
        : available_px;
    return needed > threshold;
}

export function intrinsic_width_px(element: HTMLElement): number {
    let width = element.scrollWidth;
    element.querySelectorAll<HTMLElement>('*').forEach((child) => {
        const overflow = getComputedStyle(child).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') {
            width += Math.max(0, child.scrollWidth - child.clientWidth);
        }
    });
    return width;
}

export function use_toolbar_wrap(
    refs: {
        toolbar: RefObject<HTMLElement | null>;
        lead: RefObject<HTMLElement | null>;
        chips: RefObject<HTMLElement | null>;
        actions: RefObject<HTMLElement | null>;
    },
    content_deps: readonly unknown[],
): boolean {
    const [wrapped, set_wrapped] = useState(false);
    const measure_ref = useRef<() => void>(() => {});

    useLayoutEffect(() => {
        measure_ref.current = () => {
            const toolbar = refs.toolbar.current;
            if (!toolbar) return;
            const lead_px = refs.lead.current ? intrinsic_width_px(refs.lead.current) : 0;
            let actions_px = 0;
            if (refs.actions.current) {
                const actions = Array.from(refs.actions.current.children) as HTMLElement[];
                actions.forEach((action) => { actions_px += intrinsic_width_px(action); });
                actions_px += Math.max(0, actions.length - 1) * TOOLBAR_ACTION_GAP_PX;
            }
            let chips_px = 0;
            if (refs.chips.current) {
                const strips = Array.from(refs.chips.current.children) as HTMLElement[];
                strips.forEach((strip) => { chips_px += intrinsic_width_px(strip); });
                chips_px += Math.max(0, strips.length - 1) * TOOLBAR_GAP_PX;
            }
            set_wrapped((previous) => should_wrap(
                { lead_px, chips_px, actions_px },
                toolbar.clientWidth,
                TOOLBAR_GAP_PX,
                previous,
            ));
        };
        measure_ref.current();
    }, content_deps);

    useLayoutEffect(() => {
        const toolbar = refs.toolbar.current;
        if (!toolbar || typeof ResizeObserver === 'undefined') return;
        let width = -1;
        const observer = new ResizeObserver(() => {
            if (toolbar.clientWidth === width) return;
            width = toolbar.clientWidth;
            measure_ref.current();
        });
        observer.observe(toolbar);
        return () => observer.disconnect();
    }, [refs.toolbar]);

    return wrapped;
}
