/**
 * Interactive SVG histogram with two draggable range thumbs.
 *
 * Adapted from Raven's data-viewer filter histogram: uniform-width bins, bin-edge
 * snap, stable window drag listeners, and keyboard nudging.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import type { HistogramBin } from '../types';

export type FilterHistogramProps = {
    bins: readonly HistogramBin[];
    lo: number;
    hi: number;
    on_change: (lo: number, hi: number) => void;
};

const SVG_W = 260;
const SVG_H = 52;
const AXIS_Y = SVG_H - 12;
const BAR_BOTTOM = AXIS_Y - 2;
const THUMB_R = 6;
const MARGIN_X = THUMB_R + 2;

export function domain_min(bins: readonly HistogramBin[]): number {
    return bins[0].lo;
}

export function domain_max(bins: readonly HistogramBin[]): number {
    return bins[bins.length - 1].hi;
}

export function value_to_x(value: number, d_min: number, d_max: number): number {
    if (d_max === d_min) return MARGIN_X + (SVG_W - 2 * MARGIN_X) / 2;
    return MARGIN_X + ((value - d_min) / (d_max - d_min)) * (SVG_W - 2 * MARGIN_X);
}

export function x_to_value(x: number, d_min: number, d_max: number): number {
    const frac = (x - MARGIN_X) / (SVG_W - 2 * MARGIN_X);
    return d_min + Math.max(0, Math.min(1, frac)) * (d_max - d_min);
}

export function snap_to_bin(value: number, bins: readonly HistogramBin[]): number {
    let best = bins[0].lo;
    let best_dist = Math.abs(value - best);
    for (const bin of bins) {
        for (const edge of [bin.lo, bin.hi]) {
            const distance = Math.abs(value - edge);
            if (distance < best_dist) {
                best_dist = distance;
                best = edge;
            }
        }
    }
    return best;
}

export function FilterHistogram({
    bins,
    lo,
    hi,
    on_change,
}: FilterHistogramProps): React.JSX.Element | null {
    const svg_ref = useRef<SVGSVGElement>(null);
    const dragging = useRef<'lo' | 'hi' | null>(null);

    const d_min = bins.length > 0 ? domain_min(bins) : 0;
    const d_max = bins.length > 0 ? domain_max(bins) : 0;
    const max_count = Math.max(...bins.map((bin) => bin.count), 1);
    const bin_width = bins.length > 0 ? (SVG_W - 2 * MARGIN_X) / bins.length : 0;
    const lo_x = value_to_x(lo, d_min, d_max);
    const hi_x = value_to_x(hi, d_min, d_max);

    const get_svg_x = useCallback((client_x: number): number => {
        const rect = svg_ref.current?.getBoundingClientRect();
        if (!rect) return MARGIN_X;
        return ((client_x - rect.left) / rect.width) * SVG_W;
    }, []);

    // Drag reads live lo/hi/bins/on_change from a ref so the window listeners
    // stay stable across re-renders (Raven invariant).
    const live = useRef({ bins, d_min, d_max, lo, hi, on_change, get_svg_x });
    live.current = { bins, d_min, d_max, lo, hi, on_change, get_svg_x };

    const handlers_ref = useRef<{ move: (event: PointerEvent) => void; up: () => void } | null>(null);
    if (handlers_ref.current === null) {
        const move = (event: PointerEvent) => {
            if (!dragging.current) return;
            const state = live.current;
            const raw_value = x_to_value(state.get_svg_x(event.clientX), state.d_min, state.d_max);
            const snapped = snap_to_bin(raw_value, state.bins);
            if (dragging.current === 'lo') {
                state.on_change(Math.min(snapped, state.hi), state.hi);
            } else {
                state.on_change(state.lo, Math.max(snapped, state.lo));
            }
        };
        const up = () => {
            dragging.current = null;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        handlers_ref.current = { move, up };
    }

    useEffect(() => () => {
        const handlers = handlers_ref.current;
        if (!handlers) return;
        window.removeEventListener('pointermove', handlers.move);
        window.removeEventListener('pointerup', handlers.up);
    }, []);

    const start_drag = useCallback((which: 'lo' | 'hi') => (event: React.PointerEvent) => {
        event.preventDefault();
        dragging.current = which;
        const handlers = handlers_ref.current!;
        window.addEventListener('pointermove', handlers.move);
        window.addEventListener('pointerup', handlers.up);
    }, []);

    const bin_step = bins.length > 1 ? bins[1].lo - bins[0].lo : d_max - d_min;

    if (bins.length === 0) return null;

    const on_key_down = (which: 'lo' | 'hi') => (event: React.KeyboardEvent) => {
        const step = event.shiftKey ? bin_step * 10 : bin_step;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            if (which === 'lo') on_change(Math.max(d_min, lo - step), hi);
            else on_change(lo, Math.max(lo, hi - step));
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (which === 'lo') on_change(Math.min(hi, lo + step), hi);
            else on_change(lo, Math.min(d_max, hi + step));
        }
    };

    const sel_x = Math.min(lo_x, hi_x);
    const sel_w = Math.abs(hi_x - lo_x);

    return (
        <svg
            ref={svg_ref}
            className="filter-histogram"
            width={SVG_W}
            height={SVG_H}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label="Range histogram"
            style={{
                display: 'block',
                width: '100%',
                maxWidth: `${SVG_W}px`,
                height: `${SVG_H}px`,
                cursor: 'default',
                userSelect: 'none',
            }}
        >
            {bins.map((bin, index) => {
                const bar_h = Math.round(((BAR_BOTTOM - 4) * bin.count) / max_count);
                const x = MARGIN_X + index * bin_width;
                const in_range = bin.lo >= lo && bin.hi <= hi;
                return (
                    <rect
                        key={`${bin.lo}:${bin.hi}:${index}`}
                        x={x + 0.5}
                        y={BAR_BOTTOM - bar_h}
                        width={Math.max(1, bin_width - 1)}
                        height={bar_h}
                        className={in_range ? 'filter-histogram-bar in-range' : 'filter-histogram-bar'}
                    >
                        <title>{`${bin.lo} – ${bin.hi}: ${bin.count}`}</title>
                    </rect>
                );
            })}
            <line
                x1={MARGIN_X}
                y1={AXIS_Y}
                x2={SVG_W - MARGIN_X}
                y2={AXIS_Y}
                className="filter-histogram-axis"
            />
            <rect
                x={sel_x}
                y={AXIS_Y - 2}
                width={sel_w}
                height={4}
                className="filter-histogram-range"
            />
            <circle
                cx={lo_x}
                cy={AXIS_Y}
                r={THUMB_R}
                className="filter-histogram-thumb"
                tabIndex={0}
                role="slider"
                aria-label="Lower value"
                aria-valuemin={d_min}
                aria-valuemax={d_max}
                aria-valuenow={lo}
                onPointerDown={start_drag('lo')}
                onKeyDown={on_key_down('lo')}
                style={{ cursor: 'ew-resize', outline: 'none' }}
            />
            <circle
                cx={hi_x}
                cy={AXIS_Y}
                r={THUMB_R}
                className="filter-histogram-thumb"
                tabIndex={0}
                role="slider"
                aria-label="Upper value"
                aria-valuemin={d_min}
                aria-valuemax={d_max}
                aria-valuenow={hi}
                onPointerDown={start_drag('hi')}
                onKeyDown={on_key_down('hi')}
                style={{ cursor: 'ew-resize', outline: 'none' }}
            />
        </svg>
    );
}
