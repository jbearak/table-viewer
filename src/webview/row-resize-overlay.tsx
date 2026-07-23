import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import { next_row_height } from './row-resize-model';

/** Grab strip thickness around a row border (matches the old 7px handle). */
const STRIP_THICKNESS_PX = 7;

export interface RowResizeTarget {
    /** Row whose height changes when this border is dragged. */
    row: number;
    /** Client-space Y of the border. */
    boundary_y: number;
    /** The row's current height, so a drag can offset from it. */
    height: number;
}

export interface RowResizeOverlayHandle {
    /** Position the grab strip at a border, or clear it (null). Ignored mid-drag
     *  so hover events don't yank the strip away from the active resize. */
    set_target(target: RowResizeTarget | null): void;
}

export interface RowResizeOverlayProps {
    /** Called continuously during the drag with the clamped new height (mirrors
     *  column-resize, which persists on every tick). */
    on_resize: (row: number, height: number) => void;
}

interface DragState {
    row: number;
    start_client_y: number;
    start_height: number;
    /** Client-space Y of the border at drag start, to offset the live line. */
    origin_y: number;
}

/**
 * Transparent strip painted at a single row border for drag-resize. The strip is
 * the only pointer-enabled element (everything else is `pointer-events: none`),
 * so the grid keeps normal interaction except right on the border. GridShell
 * positions the strip from Glide's `onItemHovered` args (see
 * {@link row_boundary_hit}); the strip owns the mousedown→drag→mouseup lifecycle
 * (Glide doesn't expose mouse-down). The boundary math is unit-tested in
 * {@link './row-resize-model'}; the pointer wiring is smoke-verified.
 */
export const RowResizeOverlay = forwardRef<
    RowResizeOverlayHandle,
    RowResizeOverlayProps
>(function RowResizeOverlay({ on_resize }, ref): React.JSX.Element {
    const wrapper_ref = useRef<HTMLDivElement | null>(null);
    const [target, set_target_state] = useState<RowResizeTarget | null>(null);
    const [is_dragging, set_is_dragging] = useState(false);
    // Live client-space Y of the strip during a drag (drives the visual line).
    const [drag_y, set_drag_y] = useState<number | null>(null);
    const drag_ref = useRef<DragState | null>(null);

    useImperativeHandle(
        ref,
        () => ({
            set_target(next: RowResizeTarget | null) {
                if (drag_ref.current) return; // pinned during an active drag
                set_target_state((prev) => {
                    if (prev === next) return prev;
                    if (
                        prev &&
                        next &&
                        prev.row === next.row &&
                        prev.boundary_y === next.boundary_y &&
                        prev.height === next.height
                    ) {
                        return prev;
                    }
                    return next;
                });
            },
        }),
        [],
    );

    const on_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            // Only the primary button resizes; a right/middle press must not arm
            // a drag (and must fall through so its context menu can be suppressed).
            if (e.button !== 0) return;
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();
            drag_ref.current = {
                row: target.row,
                start_client_y: e.clientY,
                start_height: target.height,
                origin_y: target.boundary_y,
            };
            set_drag_y(target.boundary_y);
            set_is_dragging(true);
        },
        [target],
    );

    // Subscribe document listeners once per drag (gated on the boolean, not the
    // live position, so each mousemove doesn't churn listeners).
    useEffect(() => {
        if (!is_dragging) return;
        const move = (e: MouseEvent) => {
            const d = drag_ref.current;
            if (!d) return;
            const dy = e.clientY - d.start_client_y;
            const height = next_row_height(d.start_height, dy);
            on_resize(d.row, height);
            // Track the live border: original boundary + the clamped delta.
            set_drag_y(d.origin_y + (height - d.start_height));
        };
        const up = () => {
            drag_ref.current = null;
            set_is_dragging(false);
            set_drag_y(null);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        return () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
    }, [is_dragging, on_resize]);

    // Convert client-space border Y to wrapper-local Y. Reading layout here is a
    // cheap, read-only reflow at human-paced hover frequency.
    const wrapper_top = wrapper_ref.current?.getBoundingClientRect().top ?? 0;
    const client_y = is_dragging ? drag_y : (target?.boundary_y ?? null);
    const local_y = client_y !== null ? client_y - wrapper_top : null;

    return (
        <div
            ref={wrapper_ref}
            className="row-resize-overlay"
            style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                overflow: 'hidden',
            }}
        >
            {local_y !== null && (
                <div
                    className="row-resize-strip"
                    onMouseDown={on_mouse_down}
                    onContextMenu={(e) => {
                        // Suppress the OS cut/copy/paste menu on the row-header
                        // border; nothing should happen here.
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: local_y - STRIP_THICKNESS_PX / 2,
                        height: STRIP_THICKNESS_PX,
                        cursor: 'row-resize',
                        pointerEvents: 'auto',
                    }}
                />
            )}
        </div>
    );
});
