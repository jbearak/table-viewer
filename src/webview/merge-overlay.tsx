import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
} from 'react';
import type { DataEditorRef, Theme } from '@glideapps/glide-data-grid';
import type { RenderedCell } from '../data-source/interface';
import type { MergeIndex } from './merge-index';
import { HEADER_HEIGHT_PX } from './grid-model';
import {
    block_font,
    block_text,
    block_should_paint,
    overlay_block_rect,
    overlay_entries,
    type CellRegion,
} from './merge-overlay-model';

/** Horizontal text inset inside a merge block; mirrors Glide's default
 *  `cellHorizontalPadding` so overlay content lines up with plain cells. */
const TEXT_PADDING_PX = 8;

export interface MergeOverlayHandle {
    /** Repaint the overlay. Pass the latest visible region on scroll; omit to
     *  reuse the last region (theme change, page load, resize). */
    repaint(region?: CellRegion): void;
}

export interface MergeOverlayProps {
    grid_ref: React.RefObject<DataEditorRef | null>;
    merge_index: MergeIndex;
    theme: Partial<Theme>;
    show_formatting: boolean;
    get_row: (row: number) => (RenderedCell | null)[] | undefined;
    get_source_row: (display_row: number) => number | undefined;
    get_cell_background: (source_row: number, source_column: number) => string | undefined;
    /** Bumps when a page or authoritative highlight state lands. */
    version: number;
    highlight_version?: number;
}

/**
 * Transparent canvas painted over the Glide grid for vertical / 2D merges
 * (rowSpan > 1), which Glide's native horizontal-only `cell.span` cannot
 * represent (Spike D0). For each such block intersecting the visible region it
 * paints background + a 4-sided border (covering the interior horizontal
 * gridlines Glide draws for multi-row spans) + the anchor's content. Covered
 * cells in the grid itself render blank (see {@link build_grid_cell}).
 *
 * Driven imperatively: GridShell calls {@link MergeOverlayHandle.repaint} from
 * `onVisibleRegionChanged` (which fires per smooth-scroll frame), so scrolling
 * keeps the blocks pinned to their cells without re-rendering React each frame.
 * `getBounds` is read live, so positioning is always against the current scroll.
 *
 * The canvas paint + `getBounds` positioning is verified by the manual smoke
 * checklist (live VS Code canvas); the geometry/selection logic lives in
 * {@link './merge-overlay-model'} and is unit-tested.
 */
export const MergeOverlay = forwardRef<MergeOverlayHandle, MergeOverlayProps>(
    function MergeOverlay(
        {
            grid_ref,
            merge_index,
            theme,
            show_formatting,
            get_row,
            get_source_row,
            get_cell_background,
            version,
            highlight_version = 0,
        },
        ref,
    ): React.JSX.Element {
        const canvas_ref = useRef<HTMLCanvasElement | null>(null);
        const region_ref = useRef<CellRegion>({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        });

        const entries = useMemo(
            () => overlay_entries(merge_index.entries),
            [merge_index],
        );

        const repaint = useCallback(
            (region?: CellRegion): boolean => {
                if (region) region_ref.current = region;
                const visible = region_ref.current;
                const canvas = canvas_ref.current;
                const grid = grid_ref.current;
                if (!canvas || !grid) return false;
                const ctx = canvas.getContext('2d');
                if (!ctx) return false;

                const dpr = window.devicePixelRatio || 1;
                const rect = canvas.getBoundingClientRect();
                const css_w = rect.width;
                const css_h = rect.height;
                const px_w = Math.round(css_w * dpr);
                const px_h = Math.round(css_h * dpr);
                if (canvas.width !== px_w || canvas.height !== px_h) {
                    canvas.width = px_w;
                    canvas.height = px_h;
                }
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, css_w, css_h);

                if (entries.length === 0) return true;

                // Glide establishes the bounds getBounds reads from only on its
                // first internal draw (its own rAF). A content-driven repaint
                // (mount / page-landed / formatting toggle) can run before that
                // draw, when getBounds still returns null and no block can be
                // positioned. Probe the always-present top-left cell: when it has
                // no bounds yet, report "not ready" so the caller can retry on a
                // later frame rather than painting nothing.
                if (!grid.getBounds(0, 0)) return false;

                const origin = { x: rect.left, y: rect.top };
                const bg = theme.bgCell ?? '#ffffff';
                const border = theme.borderColor ?? '#e1e1e1';
                const fg = theme.textDark ?? '#000000';
                const family = theme.fontFamily ?? 'sans-serif';

                // Clip to the grid body so a block scrolled partly under the
                // header never paints over the column letters.
                ctx.save();
                ctx.beginPath();
                ctx.rect(
                    0,
                    HEADER_HEIGHT_PX,
                    css_w,
                    Math.max(0, css_h - HEADER_HEIGHT_PX),
                );
                ctx.clip();

                for (const entry of entries) {
                    if (!block_should_paint(entry, visible)) continue;
                    const tl = grid.getBounds(entry.startCol, entry.startRow);
                    const br = grid.getBounds(entry.endCol, entry.endRow);
                    if (!tl || !br) continue;

                    const r = overlay_block_rect(tl, br, origin);
                    if (r.width <= 0 || r.height <= 0) continue;

                    // Base fill covers blank covered cells + interior gridlines.
                    ctx.fillStyle = bg;
                    ctx.fillRect(r.x, r.y, r.width, r.height);
                    const source_row = get_source_row(entry.startRow);
                    const highlight = source_row === undefined
                        ? undefined
                        : get_cell_background(source_row, entry.startCol);
                    if (highlight) {
                        ctx.fillStyle = highlight;
                        ctx.fillRect(r.x, r.y, r.width, r.height);
                    }

                    // Outer border at half-pixels for a crisp 1px line.
                    ctx.strokeStyle = border;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);

                    const anchor = get_row(entry.startRow)?.[entry.startCol];
                    const text = anchor ? block_text(anchor, show_formatting) : '';
                    if (anchor && text) {
                        const bold = show_formatting && anchor.bold;
                        const italic = show_formatting && anchor.italic;
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(r.x, r.y, r.width, r.height);
                        ctx.clip();
                        ctx.fillStyle = fg;
                        ctx.font = block_font(bold, italic, family);
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(
                            text,
                            r.x + TEXT_PADDING_PX,
                            r.y + r.height / 2,
                        );
                        ctx.restore();
                    }
                }

                ctx.restore();
                return true;
            },
            [
                entries,
                grid_ref,
                theme,
                show_formatting,
                get_row,
                get_source_row,
                get_cell_background,
            ],
        );

        useImperativeHandle(ref, () => ({ repaint }), [repaint]);

        // Repaint when content/theme/formatting change (version bump = page
        // landed). Glide's getBounds is unusable until its first internal draw,
        // which may land after this effect runs — a single repaint here can lose
        // that race and paint nothing on the initial frame. Retry on successive
        // animation frames until repaint reports it found usable bounds (or we
        // hit a frame cap). onVisibleRegionChanged also drives repaint once Glide
        // settles, so this is the belt to that suspenders: whichever resolves
        // bounds first paints, without waiting on a user scroll.
        useEffect(() => {
            let frame = 0;
            let attempts = 0;
            const MAX_ATTEMPTS = 120; // ~2s at 60fps.
            const tick = () => {
                if (repaint() || attempts >= MAX_ATTEMPTS) return;
                attempts += 1;
                frame = requestAnimationFrame(tick);
            };
            tick();
            return () => cancelAnimationFrame(frame);
        }, [repaint, version, highlight_version]);

        // Repaint on container resize (the grid relayouts outside React).
        useEffect(() => {
            const canvas = canvas_ref.current;
            if (!canvas || typeof ResizeObserver === 'undefined') return;
            const observer = new ResizeObserver(() => repaint());
            observer.observe(canvas);
            return () => observer.disconnect();
        }, [repaint]);

        return (
            <canvas
                ref={canvas_ref}
                className="merge-overlay"
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                }}
            />
        );
    },
);
