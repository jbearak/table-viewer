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
    block_intersects_region,
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
    /** Bumps when a page lands so content re-paints over its placeholder. */
    version: number;
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
        { grid_ref, merge_index, theme, show_formatting, get_row, version },
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
            (region?: CellRegion) => {
                if (region) region_ref.current = region;
                const visible = region_ref.current;
                const canvas = canvas_ref.current;
                const grid = grid_ref.current;
                if (!canvas || !grid) return;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;

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

                if (entries.length === 0) return;

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
                    if (!block_intersects_region(entry, visible)) continue;
                    const tl = grid.getBounds(entry.startCol, entry.startRow);
                    const br = grid.getBounds(entry.endCol, entry.endRow);
                    if (!tl || !br) continue;

                    const r = overlay_block_rect(tl, br, origin);
                    if (r.width <= 0 || r.height <= 0) continue;

                    // Fill covers the blank covered cells + interior gridlines.
                    ctx.fillStyle = bg;
                    ctx.fillRect(r.x, r.y, r.width, r.height);

                    // Outer border at half-pixels for a crisp 1px line.
                    ctx.strokeStyle = border;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);

                    const anchor = get_row(entry.startRow)?.[entry.startCol];
                    if (anchor && anchor.formatted) {
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
                            anchor.formatted,
                            r.x + TEXT_PADDING_PX,
                            r.y + r.height / 2,
                        );
                        ctx.restore();
                    }
                }

                ctx.restore();
            },
            [entries, grid_ref, theme, show_formatting, get_row],
        );

        useImperativeHandle(ref, () => ({ repaint }), [repaint]);

        // Repaint when content/theme/formatting change (version bump = page landed).
        useEffect(() => {
            repaint();
        }, [repaint, version]);

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
