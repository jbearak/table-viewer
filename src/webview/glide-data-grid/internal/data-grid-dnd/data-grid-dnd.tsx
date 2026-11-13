/* eslint-disable unicorn/consistent-destructuring */
import { clamp } from "../../common/collection-utils.js";
import * as React from "react";
import DataGrid, { type DataGridProps, type DataGridRef } from "../data-grid/data-grid.js";
import type { GridColumn, InnerGridColumn, Rectangle } from "../data-grid/data-grid-types.js";
import type { GridMouseEventArgs } from "../data-grid/event-args.js";
import { useAutoscroll } from "../../data-editor/use-autoscroll.js";

type Props = Omit<
    DataGridProps,
    | "dragAndDropState"
    | "isResizing"
    | "isDragging"
    | "isDragRefused"
    | "onMouseMoveRaw"
    | "allowResize"
    | "resizeColumn"
>;

const nullScrollRef: React.MutableRefObject<HTMLDivElement | null> = { current: null };

export interface DataGridDndProps extends Props {
    /**
     * Fork change: called when the user drops a dragged block of rows. A drag arms only when a plain primary press
     * lands on a row marker inside the current contiguous row selection (and `canMoveRows` allows that block); it
     * then moves the whole block. `rows` is that block, inclusive; `before` is the row it lands before, `rows` for
     * the end. Pressing any other marker keeps the ordinary marker press (drag-to-select, menus, touch).
     * @group Drag and Drop
     */
    readonly onRowMoved?: (rows: RowMoveBlock, before: number) => void;
    /**
     * Fork addition: whether a press inside the selected block `rows` may start a row move. Returning false keeps
     * the ordinary marker press.
     * @group Drag and Drop
     */
    readonly canMoveRows?: (rows: RowMoveBlock) => boolean;
    /**
     * Fork addition: called when a row move's drop target changes. `before` is the row the block would land
     * before, `rows` for the end, or -1 above the first row (over the header). Returning false refuses the drop:
     * no drop indicator, the not-allowed cursor, and releasing does nothing.
     * @group Drag and Drop
     */
    readonly onRowProposeMove?: (rows: RowMoveBlock, before: number) => boolean;
    /**
     * Called when the user finishes moving a column. `startIndex` is the index of the column that was moved, and
     * `endIndex` is the index at which it should end up. Note that you have to effect the move of the column, and pass
     * the reordered columns back in the `columns` property.
     * @group Drag and Drop
     */
    readonly onColumnMoved?: (startIndex: number, endIndex: number) => void;

    /**
     * Called when the user is dragging a column and proposes to move it to a new location. Return `false` to prevent
     * @param startIndex
     * @param endIndex
     * @group Drag and Drop
     */
    readonly onColumnProposeMove?: (startIndex: number, endIndex: number) => boolean;

    /**
     * Called when the user is resizing a column. `newSize` is the new size of the column. Note that you have change
     * the size of the column in the `GridColumn` and pass it back to the grid in the `columns` property.
     * @group Drag and Drop
     * @param column The `GridColumn` being resized
     * @param newSize The new size of the grid column
     * @param colIndex The index of the column
     * @param newSizeWithGrow The new size of the column including any addition pixels added by the grow parameter
     */
    readonly onColumnResize?: (column: GridColumn, newSize: number, colIndex: number, newSizeWithGrow: number) => void;
    /**
     * Called when the user starts resizing a column. `newSize` is the new size of the column.
     * @group Drag and Drop
     * @param column The `GridColumn` being resized
     * @param newSize The new size of the grid column
     * @param colIndex The index of the column
     * @param newSizeWithGrow The new size of the column including any addition pixels added by the grow parameter
     */
    readonly onColumnResizeStart?: (
        column: GridColumn,
        newSize: number,
        colIndex: number,
        newSizeWithGrow: number
    ) => void;
    /**
     * Called when the user finishes resizing a column. `newSize` is the new size of the column.
     * @group Drag and Drop
     * @param column The `GridColumn` being resized
     * @param newSize The new size of the grid column
     * @param colIndex The index of the column
     * @param newSizeWithGrow The new size of the column including any addition pixels added by the grow parameter
     */
    readonly onColumnResizeEnd?: (
        column: GridColumn,
        newSize: number,
        colIndex: number,
        newSizeWithGrow: number
    ) => void;

    readonly gridRef?: React.MutableRefObject<DataGridRef | null>;
    readonly maxColumnWidth: number;
    readonly minColumnWidth: number;
    readonly lockColumns: number;
}

/** A contiguous block of rows, inclusive at both ends. */
export interface RowMoveBlock {
    readonly start: number;
    readonly end: number;
}

/** Fork addition: pointer travel, in CSS px, before an armed row press becomes a move (Glide's column threshold). */
export const ROW_MOVE_THRESHOLD_PX = 20;
/** Fork addition: thickness of the drop indicator drawn between rows. */
export const ROW_MOVE_INDICATOR_PX = 2;

/**
 * Fork addition: the block a marker press on `row` would move: the current row selection when it is one contiguous
 * interval containing `row`, else undefined (the press stays an ordinary marker press).
 */
export function rowMoveBlockForPress(
    rows: { readonly length: number; first(): number | undefined; last(): number | undefined },
    row: number
): RowMoveBlock | undefined {
    const first = rows.first();
    const last = rows.last();
    if (first === undefined || last === undefined) return undefined;
    if (rows.length !== last - first + 1) return undefined;
    if (row < first || row > last) return undefined;
    return { start: first, end: last };
}

/** Fork addition: whether dropping `rows` before `before` leaves every row where it is. */
export function rowMoveIsNoOp(rows: RowMoveBlock, before: number): boolean {
    return before >= rows.start && before <= rows.end + 1;
}

/**
 * Fork addition: the row a block would land before for a pointer at `pointerY` over `row`, whose top is `rowTop`
 * and height `rowHeight`: the row itself in its upper half, the next row in its lower half.
 */
export function rowMoveDropBefore(row: number, pointerY: number, rowTop: number, rowHeight: number): number {
    return pointerY < rowTop + rowHeight / 2 ? row : row + 1;
}

/**
 * Fork addition: vertical auto-scroll while a row move's pointer is within one row height of the top (below the
 * header, or over it) or bottom edge of the viewport.
 */
export function rowMoveScrollDirection(
    pointerY: number,
    headerBottom: number,
    viewportBottom: number,
    rowHeight: number
): -1 | 0 | 1 {
    if (pointerY < headerBottom + rowHeight) return -1;
    if (pointerY > viewportBottom - rowHeight) return 1;
    return 0;
}

// Dear Past Jason,
// Wtf does this function do? If you remember in the future come back and add a comment
// -- Future-Past Jason
function offsetColumnSize(column: InnerGridColumn, width: number, min: number, max: number): number {
    return clamp(Math.round(width - (column.growOffset ?? 0)), Math.ceil(min), Math.floor(max));
}

/** Width of the viewport strip that turns an outward final-column resize into
 * horizontal edge scrolling. */
export const COLUMN_RESIZE_EDGE_SCROLL_ZONE_PX = 24;
/** Equivalent to 12 px per frame at 60 Hz, independent of display refresh rate. */
export const COLUMN_RESIZE_EDGE_SCROLL_MAX_PX_PER_SECOND = 720;
/** A backgrounded window must not return with one enormous resize jump. */
export const COLUMN_RESIZE_EDGE_SCROLL_MAX_ELAPSED_MS = 50;

/** Edge-scroll velocity with a quadratic ramp for fine control at the start of
 * the activation strip. */
export function columnResizeEdgeScrollSpeed(pointerX: number, viewportRight: number): number {
    const depth = clamp(
        (pointerX - (viewportRight - COLUMN_RESIZE_EDGE_SCROLL_ZONE_PX)) /
            COLUMN_RESIZE_EDGE_SCROLL_ZONE_PX,
        0,
        1
    );
    if (depth === 0) return 0;
    return Math.max(60, COLUMN_RESIZE_EDGE_SCROLL_MAX_PX_PER_SECOND * depth * depth);
}

export function columnResizeEdgeScrollDistance(
    pointerX: number,
    viewportRight: number,
    elapsedMs: number
): number {
    const boundedElapsed = clamp(elapsedMs, 0, COLUMN_RESIZE_EDGE_SCROLL_MAX_ELAPSED_MS);
    return columnResizeEdgeScrollSpeed(pointerX, viewportRight) * boundedElapsed / 1000;
}

export function columnResizeEdgeScrollDistanceBeforeMax(
    distance: number,
    currentRawWidth: number,
    maximumRawWidth: number
): number {
    return Math.min(distance, Math.max(0, maximumRawWidth - currentRawWidth));
}

/** A resize consumes both physical pointer travel and scroll travel. The latter
 * is what lets a divider keep growing while the pointer is held at the edge. */
export function columnResizeWidthFromPointer(
    pointerX: number,
    columnStartX: number,
    scrollLeft: number,
    startScrollLeft: number,
    scale: number
): number {
    return (pointerX - columnStartX) / scale + scrollLeft - startScrollLeft;
}

const DataGridDnd: React.FunctionComponent<DataGridDndProps> = p => {
    const [resizeCol, setResizeCol] = React.useState<number>();
    const resizeColRef = React.useRef<number>();
    const resizeColStartXRef = React.useRef<number>();
    const resizeStartScrollLeftRef = React.useRef(0);
    const resizeScaleRef = React.useRef(1);
    const resizePointerXRef = React.useRef<number>();
    const resizeAnimationFrameRef = React.useRef<number>();
    const resizeEdgeScrollTickRef = React.useRef<(timestamp: number) => void>(() => undefined);
    const resizeEdgeScrollLastTimeRef = React.useRef<number>();

    const [dragCol, setDragCol] = React.useState<number>();
    const [dropCol, setDropCol] = React.useState<number>();
    const [dragColActive, setDragColActive] = React.useState(false);
    const [dragStartX, setDragStartX] = React.useState<number>();

    // Fork change: a row move is armed by a press inside the selected block, held
    // in a ref so mouse handlers read it synchronously, and mirrored into state
    // for the indicator and cursor. The armed press itself is withheld from the
    // data editor until release, so a press that never moves replays as today's.
    const rowMoveRef = React.useRef<{
        readonly rows: RowMoveBlock;
        readonly startY: number;
        readonly press: GridMouseEventArgs;
        active: boolean;
        before?: number;
        allowed: boolean;
        rowHeight: number;
    }>();
    const [rowMoveView, setRowMoveView] = React.useState<{
        readonly rows: RowMoveBlock;
        readonly before?: number;
        readonly allowed: boolean;
    }>();
    const [rowMoveScroll, setRowMoveScroll] = React.useState<-1 | 0 | 1>(0);
    const lastPointerYRef = React.useRef<number>();
    const dragRowActive = rowMoveView !== undefined;

    const {
        onHeaderMenuClick,
        getCellContent,
        onColumnMoved,
        onColumnResize,
        onColumnResizeStart,
        onColumnResizeEnd,
        gridRef,
        maxColumnWidth,
        minColumnWidth,
        onRowMoved,
        canMoveRows,
        onRowProposeMove,
        lockColumns,
        onColumnProposeMove,
        onMouseDown,
        onMouseUp,
        onItemHovered,
        onDragStart,
        canvasRef,
        eventTargetRef,
    } = p;

    const canResize = (onColumnResize ?? onColumnResizeEnd ?? onColumnResizeStart) !== undefined;

    const { columns, selection } = p;
    const selectedColumns = selection.columns;
    const lastResizeWidthRef = React.useRef(-1);

    const stopResizeEdgeScroll = React.useCallback(() => {
        if (resizeAnimationFrameRef.current !== undefined) {
            window.cancelAnimationFrame(resizeAnimationFrameRef.current);
            resizeAnimationFrameRef.current = undefined;
        }
        resizeEdgeScrollLastTimeRef.current = undefined;
    }, []);

    const fanOutSelectedColumnResize = React.useCallback(
        (
            currentResizeCol: number,
            rawWidth: number,
            callback: DataGridDndProps["onColumnResize"]
        ) => {
            if (callback === undefined) return;
            for (const selected of selectedColumns) {
                if (selected === currentResizeCol) continue;
                const selectedColumn = columns[selected];
                const selectedSize = offsetColumnSize(
                    selectedColumn,
                    rawWidth,
                    minColumnWidth,
                    maxColumnWidth
                );
                callback(
                    selectedColumn,
                    selectedSize,
                    selected,
                    selectedSize + (selectedColumn.growOffset ?? 0)
                );
            }
        },
        [columns, maxColumnWidth, minColumnWidth, selectedColumns]
    );

    const applyColumnResizeAtPointer = React.useCallback((pointerX: number) => {
        const colIndex = resizeColRef.current;
        const startX = resizeColStartXRef.current;
        const canvas = canvasRef?.current;
        if (colIndex === undefined || startX === undefined || canvas === null) return;

        const scroller = eventTargetRef?.current;
        const rawWidth = columnResizeWidthFromPointer(
            pointerX,
            startX,
            scroller?.scrollLeft ?? resizeStartScrollLeftRef.current,
            resizeStartScrollLeftRef.current,
            resizeScaleRef.current
        );
        const column = columns[colIndex];
        const size = offsetColumnSize(column, rawWidth, minColumnWidth, maxColumnWidth);
        onColumnResize?.(column, size, colIndex, size + (column.growOffset ?? 0));
        lastResizeWidthRef.current = rawWidth;

        if (selectedColumns?.first() === colIndex) {
            fanOutSelectedColumnResize(colIndex, rawWidth, onColumnResize);
        }
    }, [
        canvasRef,
        columns,
        eventTargetRef,
        fanOutSelectedColumnResize,
        maxColumnWidth,
        minColumnWidth,
        onColumnResize,
        selectedColumns,
    ]);

    const scheduleResizeEdgeScroll = React.useCallback(() => {
        if (resizeAnimationFrameRef.current !== undefined) return;
        resizeAnimationFrameRef.current = window.requestAnimationFrame(timestamp => {
            resizeAnimationFrameRef.current = undefined;
            resizeEdgeScrollTickRef.current(timestamp);
        });
    }, []);

    const resizeEdgeScrollTick = React.useCallback(
        (timestamp: number) => {
            const colIndex = resizeColRef.current;
            const pointerX = resizePointerXRef.current;
            const scroller = eventTargetRef?.current;
            if (colIndex === undefined || pointerX === undefined || scroller == null) return;
            if (colIndex !== columns.length - 1) return;

            const previousTimestamp = resizeEdgeScrollLastTimeRef.current;
            resizeEdgeScrollLastTimeRef.current = timestamp;
            const frameDistance = columnResizeEdgeScrollDistance(
                pointerX,
                scroller.getBoundingClientRect().right,
                previousTimestamp === undefined ? 1000 / 60 : timestamp - previousTimestamp
            );

            const column = columns[colIndex];
            const maximumRawWidth = maxColumnWidth + (column.growOffset ?? 0);
            const distance = columnResizeEdgeScrollDistanceBeforeMax(
                frameDistance,
                lastResizeWidthRef.current,
                maximumRawWidth
            );
            if (distance === 0) return;

            const before = scroller.scrollLeft;
            scroller.scrollLeft = before + distance;
            if (scroller.scrollLeft !== before) {
                applyColumnResizeAtPointer(pointerX);
                scheduleResizeEdgeScroll();
            } else {
                // A controlled grid may not have applied the preceding width yet,
                // or may intentionally ignore it. Stop the hot loop; a later
                // columns update restarts edge scrolling below.
                resizeEdgeScrollLastTimeRef.current = undefined;
            }
        },
        [applyColumnResizeAtPointer, columns, eventTargetRef, maxColumnWidth, scheduleResizeEdgeScroll]
    );

    React.useLayoutEffect(() => {
        resizeEdgeScrollTickRef.current = resizeEdgeScrollTick;
    }, [resizeEdgeScrollTick]);

    React.useEffect(() => {
        const colIndex = resizeColRef.current;
        const pointerX = resizePointerXRef.current;
        const scroller = eventTargetRef?.current;
        if (colIndex !== columns.length - 1 || pointerX === undefined || scroller == null) return;
        if (columnResizeEdgeScrollSpeed(pointerX, scroller.getBoundingClientRect().right) === 0) return;
        scheduleResizeEdgeScroll();
    }, [columns, eventTargetRef, scheduleResizeEdgeScroll]);

    React.useEffect(() => stopResizeEdgeScroll, [stopResizeEdgeScroll]);

    const onItemHoveredImpl = React.useCallback(
        (args: GridMouseEventArgs) => {
            const [col] = args.location;
            if (dragCol !== undefined && dropCol !== col && col >= lockColumns) {
                setDragColActive(true);
                setDropCol(col);
            } else if (rowMoveRef.current !== undefined) {
                // Fork change: an armed row move owns the pointer and hides it
                // from drag-to-select; its drop target follows onMouseMove.
            // Don't emit onItemHovered if resizing or reordering a column or row.
            } else if (resizeCol === undefined && !dragColActive && !dragRowActive) {
                onItemHovered?.(args);
            }
        },
        [dragCol, dropCol, onItemHovered, lockColumns, resizeCol, dragColActive, dragRowActive]
    );

    const canDragCol = onColumnMoved !== undefined;
    const onMouseDownImpl = React.useCallback(
        (args: GridMouseEventArgs) => {
            if (args.button === 0) {
                const [col, row] = args.location;
                if (args.kind === "out-of-bounds" && args.isEdge && canResize) {
                    const bounds = gridRef?.current?.getBounds(columns.length - 1, -1);
                    const canvas = canvasRef?.current;
                    if (bounds !== undefined && canvas) {
                        resizeColStartXRef.current = bounds.x;
                        resizeStartScrollLeftRef.current = eventTargetRef?.current?.scrollLeft ?? 0;
                        setResizeCol(columns.length - 1);
                        resizeColRef.current = columns.length - 1;
                        const rect = canvas.getBoundingClientRect();
                        const scale = rect.width / canvas.offsetWidth;
                        resizeScaleRef.current = scale;
                        const width = bounds.width / scale;
                        lastResizeWidthRef.current = width;
                        const column = columns[columns.length - 1];
                        onColumnResizeStart?.(
                            column,
                            width,
                            columns.length - 1,
                            width + (column.growOffset ?? 0)
                        );
                    }
                } else if (args.kind === "header" && col >= lockColumns) {
                    const canvas = canvasRef?.current;
                    if (args.isEdge && canResize && canvas) {
                        resizeColStartXRef.current = args.bounds.x;
                        resizeStartScrollLeftRef.current = eventTargetRef?.current?.scrollLeft ?? 0;
                        setResizeCol(col);
                        resizeColRef.current = col;
                        const rect = canvas.getBoundingClientRect();
                        const scale = rect.width / canvas.offsetWidth;
                        resizeScaleRef.current = scale;
                        const width = args.bounds.width / scale;
                        lastResizeWidthRef.current = width;
                        onColumnResizeStart?.(columns[col], width, col, width + (columns[col].growOffset ?? 0));
                    } else if (args.kind === "header" && canDragCol) {
                        setDragStartX(args.bounds.x);
                        setDragCol(col);
                    }
                } else if (
                    args.kind === "cell" &&
                    lockColumns > 0 &&
                    col === 0 &&
                    row !== undefined &&
                    onRowMoved !== undefined &&
                    !args.isTouch &&
                    !args.shiftKey &&
                    !args.ctrlKey &&
                    !args.metaKey
                ) {
                    // Fork change: arm a move only for a press inside the
                    // current contiguous row selection, and withhold the press
                    // from the data editor, whose marker click would collapse
                    // that selection. Release replays it if no move started.
                    const rows = rowMoveBlockForPress(selection.rows, row);
                    if (rows !== undefined && canMoveRows?.(rows) !== false) {
                        lastPointerYRef.current = args.bounds.y + args.localEventY;
                        rowMoveRef.current = {
                            rows,
                            startY: args.bounds.y + args.localEventY,
                            press: args,
                            active: false,
                            allowed: false,
                            rowHeight: args.bounds.height,
                        };
                        return;
                    }
                }
            }
            onMouseDown?.(args);
        },
        [
            onMouseDown,
            canResize,
            lockColumns,
            onRowMoved,
            canMoveRows,
            selection.rows,
            gridRef,
            columns,
            canDragCol,
            onColumnResizeStart,
            canvasRef,
            eventTargetRef,
        ]
    );

    const onHeaderMenuClickMangled = React.useCallback(
        (col: number, screenPosition: Rectangle) => {
            if (dragColActive || dragRowActive) return;
            onHeaderMenuClick?.(col, screenPosition);
        },
        [dragColActive, dragRowActive, onHeaderMenuClick]
    );

    const clearAll = React.useCallback(() => {
        stopResizeEdgeScroll();
        lastResizeWidthRef.current = -1;
        resizeColRef.current = undefined;
        resizeColStartXRef.current = undefined;
        resizePointerXRef.current = undefined;
        rowMoveRef.current = undefined;
        setRowMoveView(undefined);
        setRowMoveScroll(0);
        setDragCol(undefined);
        setDropCol(undefined);
        setDragStartX(undefined);
        setDragColActive(false);
        setResizeCol(undefined);
    }, [stopResizeEdgeScroll]);

    const finishColumnResize = React.useCallback(() => {
        const currentResizeCol = resizeColRef.current;
        if (currentResizeCol === undefined) return;

        // If the column is in the selection, the selection may contain extra
        // columns. Re-send the last resize to all of them before the end event.
        if (selectedColumns?.hasIndex(currentResizeCol) === true) {
            fanOutSelectedColumnResize(currentResizeCol, lastResizeWidthRef.current, onColumnResize);
        }

        const column = columns[currentResizeCol];
        const size = offsetColumnSize(column, lastResizeWidthRef.current, minColumnWidth, maxColumnWidth);
        onColumnResizeEnd?.(column, size, currentResizeCol, size + (column.growOffset ?? 0));
        if (selectedColumns.hasIndex(currentResizeCol)) {
            fanOutSelectedColumnResize(currentResizeCol, lastResizeWidthRef.current, onColumnResizeEnd);
        }
    }, [
        columns,
        fanOutSelectedColumnResize,
        maxColumnWidth,
        minColumnWidth,
        onColumnResize,
        onColumnResizeEnd,
        selectedColumns,
    ]);

    const finishInterruptedResize = React.useCallback(() => {
        if (resizeColRef.current === undefined) return;
        finishColumnResize();
        clearAll();
    }, [clearAll, finishColumnResize]);

    const onMouseUpImpl = React.useCallback(
        (args: GridMouseEventArgs, isOutside: boolean) => {
            if (args.button === 0) {
                const rowMove = rowMoveRef.current;
                finishColumnResize();
                clearAll();
                if (dragCol !== undefined && dropCol !== undefined) {
                    onColumnMoved?.(dragCol, dropCol);
                }
                if (rowMove?.active === true) {
                    if (
                        rowMove.before !== undefined &&
                        rowMove.allowed &&
                        !rowMoveIsNoOp(rowMove.rows, rowMove.before)
                    ) {
                        onRowMoved?.(rowMove.rows, rowMove.before);
                    }
                } else if (rowMove !== undefined) {
                    // Fork change: a press that never became a move is the
                    // ordinary marker press it would have been: replay it.
                    onMouseDown?.(rowMove.press);
                }
            }
            onMouseUp?.(args, isOutside);
        },
        [
            onMouseUp,
            onMouseDown,
            dragCol,
            dropCol,
            onColumnMoved,
            onRowMoved,
            clearAll,
            finishColumnResize,
        ]
    );

    // Fork addition: Escape, blur, or a canceled pointer abandons a row move;
    // the release that follows then does nothing.
    const cancelRowMove = React.useCallback(() => {
        if (rowMoveRef.current === undefined) return;
        rowMoveRef.current = undefined;
        setRowMoveView(undefined);
        setRowMoveScroll(0);
    }, []);

    React.useEffect(() => {
        const interrupt = () => {
            finishInterruptedResize();
            cancelRowMove();
        };
        const finishResizeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") interrupt();
        };
        window.addEventListener("blur", interrupt);
        window.addEventListener("pointercancel", interrupt);
        window.addEventListener("keydown", finishResizeOnEscape);
        return () => {
            window.removeEventListener("blur", interrupt);
            window.removeEventListener("pointercancel", interrupt);
            window.removeEventListener("keydown", finishResizeOnEscape);
        };
    }, [cancelRowMove, finishInterruptedResize]);

    const dragOffset = React.useMemo(() => {
        if (dragCol === undefined || dropCol === undefined) return undefined;
        if (dragCol === dropCol) return undefined;

        if (onColumnProposeMove?.(dragCol, dropCol) === false) return undefined;

        return {
            src: dragCol,
            dest: dropCol,
        };
    }, [dragCol, dropCol, onColumnProposeMove]);

    const onMouseMove = React.useCallback(
        (event: MouseEvent) => {
            const canvas = canvasRef?.current;
            // A release outside the webview may not deliver mouseup. The first
            // later move still reports the current primary-button state.
            if (resizeColRef.current !== undefined && (event.buttons & 1) === 0) {
                finishInterruptedResize();
                return;
            }
            if (dragCol !== undefined && dragStartX !== undefined) {
                const diff = Math.abs(event.clientX - dragStartX);
                if (diff > 20) {
                    setDragColActive(true);
                }
            } else if (rowMoveRef.current !== undefined) {
                lastPointerYRef.current = event.clientY;
                if ((event.buttons & 1) === 0) cancelRowMove();
            } else if (resizeCol !== undefined && canvas) {
                resizePointerXRef.current = event.clientX;
                applyColumnResizeAtPointer(event.clientX);
                const scroller = eventTargetRef?.current;
                if (
                    resizeCol === columns.length - 1 &&
                    scroller != null &&
                    columnResizeEdgeScrollSpeed(event.clientX, scroller.getBoundingClientRect().right) > 0
                ) {
                    scheduleResizeEdgeScroll();
                } else {
                    stopResizeEdgeScroll();
                }
            }
        },
        [
            dragCol,
            dragStartX,
            cancelRowMove,
            resizeCol,
            columns,
            canvasRef,
            applyColumnResizeAtPointer,
            eventTargetRef,
            finishInterruptedResize,
            scheduleResizeEdgeScroll,
            stopResizeEdgeScroll,
        ]
    );

    // Fork change: a row move shows a drop indicator instead of previewing the
    // rows in their new order.
    const rows = p.rows;
    const indicatorBefore =
        rowMoveView?.before !== undefined &&
        rowMoveView.allowed &&
        !rowMoveIsNoOp(rowMoveView.rows, rowMoveView.before)
            ? rowMoveView.before
            : undefined;
    const rowMoveRefused =
        rowMoveView?.before !== undefined &&
        !rowMoveView.allowed &&
        !rowMoveIsNoOp(rowMoveView.rows, rowMoveView.before);
    const baseDrawCell = p.drawCell;
    const drawCell = React.useMemo<DataGridProps["drawCell"]>(() => {
        if (indicatorBefore === undefined) return baseDrawCell;
        return (args, drawContent) => {
            if (baseDrawCell === undefined) drawContent();
            else baseDrawCell(args, drawContent);
            const atTop = args.row === indicatorBefore;
            const atBottom = indicatorBefore >= rows && args.row === rows - 1;
            if (!atTop && !atBottom) return;
            const { ctx, rect, theme } = args;
            ctx.save();
            ctx.fillStyle = theme.accentColor;
            ctx.fillRect(
                rect.x,
                atTop ? rect.y : rect.y + rect.height - ROW_MOVE_INDICATOR_PX,
                rect.width,
                ROW_MOVE_INDICATOR_PX
            );
            ctx.restore();
        };
    }, [baseDrawCell, indicatorBefore, rows]);

    /** Fork addition: record a row move's drop target and ask whether it may land there. */
    const setRowMoveDrop = React.useCallback(
        (before: number) => {
            const rowMove = rowMoveRef.current;
            if (rowMove === undefined) return;
            if (rowMove.before !== before) {
                rowMove.before = before;
                rowMove.allowed = rowMoveIsNoOp(rowMove.rows, before)
                    ? true
                    : onRowProposeMove?.(rowMove.rows, before) ?? before >= 0;
            }
            if (rowMove.active) {
                setRowMoveView(view =>
                    view !== undefined &&
                    view.before === rowMove.before &&
                    view.allowed === rowMove.allowed &&
                    view.rows === rowMove.rows
                        ? view
                        : { rows: rowMove.rows, before: rowMove.before, allowed: rowMove.allowed }
                );
            }
        },
        [onRowProposeMove]
    );

    /** Fork addition: the row under a viewport Y, found by walking from a nearby row's bounds. */
    const rowAtPointer = React.useCallback(
        (pointerY: number, from: number): { row: number; top: number; height: number } | undefined => {
            const grid = gridRef?.current;
            if (grid === null || grid === undefined || rows <= 0) return undefined;
            let row = clamp(from, 0, rows - 1);
            let bounds = grid.getBounds(0, row);
            for (let guard = 0; bounds !== undefined && guard < rows; guard++) {
                if (pointerY < bounds.y && row > 0) row -= 1;
                else if (pointerY >= bounds.y + bounds.height && row < rows - 1) row += 1;
                else break;
                bounds = grid.getBounds(0, row);
            }
            return bounds === undefined ? undefined : { row, top: bounds.y, height: bounds.height };
        },
        [gridRef, rows]
    );

    const headerBottom = p.headerHeight + p.groupHeaderHeight;
    /** Fork addition: follow an armed row move's pointer: threshold, drop target, and edge scrolling. */
    const onMouseMoveImpl = React.useCallback(
        (args: GridMouseEventArgs) => {
            const rowMove = rowMoveRef.current;
            if (rowMove !== undefined) {
                const pointerY = lastPointerYRef.current ?? rowMove.startY;
                if (!rowMove.active && Math.abs(pointerY - rowMove.startY) > ROW_MOVE_THRESHOLD_PX) {
                    rowMove.active = true;
                }
                if (args.kind === "cell") {
                    const [, row] = args.physicalLocation ?? args.location;
                    const bounds = args.physicalBounds ?? args.bounds;
                    rowMove.rowHeight = bounds.height;
                    setRowMoveDrop(rowMoveDropBefore(row, pointerY, bounds.y, bounds.height));
                } else if (args.kind === "header" || args.kind === "group-header") {
                    setRowMoveDrop(-1);
                } else if (args.kind === "out-of-bounds") {
                    if (args.region[1] < 0) setRowMoveDrop(-1);
                    else if (args.region[1] > 0) setRowMoveDrop(rows);
                    else if (rowMove.before === undefined) setRowMoveDrop(rowMove.rows.start);
                    else setRowMoveDrop(rowMove.before);
                }
                const canvas = canvasRef?.current;
                if (rowMove.active && canvas !== null && canvas !== undefined) {
                    const rect = canvas.getBoundingClientRect();
                    setRowMoveScroll(
                        rowMoveScrollDirection(
                            pointerY - rect.top,
                            headerBottom,
                            rect.height,
                            rowMove.rowHeight
                        )
                    );
                }
            }
            p.onMouseMove(args);
        },
        [canvasRef, headerBottom, p.onMouseMove, rows, setRowMoveDrop]
    );

    /** Fork addition: rows scroll under a still pointer while edge scrolling; keep the drop target under it. */
    const onRowMoveScroll = React.useCallback(() => {
        const rowMove = rowMoveRef.current;
        const pointerY = lastPointerYRef.current;
        if (rowMove === undefined || pointerY === undefined) return;
        const canvas = canvasRef?.current;
        if (canvas !== null && canvas !== undefined && pointerY < canvas.getBoundingClientRect().top + headerBottom) {
            setRowMoveDrop(-1);
            return;
        }
        const hit = rowAtPointer(pointerY, rowMove.before ?? rowMove.rows.start);
        if (hit !== undefined) setRowMoveDrop(rowMoveDropBefore(hit.row, pointerY, hit.top, hit.height));
    }, [canvasRef, headerBottom, rowAtPointer, setRowMoveDrop]);
    useAutoscroll(rowMoveScroll === 0 ? undefined : [0, rowMoveScroll], eventTargetRef ?? nullScrollRef, onRowMoveScroll);

    const onDragStartImpl = React.useCallback<NonNullable<DataGridDndProps["onDragStart"]>>(
        args => {
            onDragStart?.(args);
            if (!args.defaultPrevented()) {
                clearAll();
            }
        },
        [clearAll, onDragStart]
    );

    return (
        <DataGrid
            accessibilityHeight={p.accessibilityHeight}
            canvasRef={p.canvasRef}
            cellXOffset={p.cellXOffset}
            cellYOffset={p.cellYOffset}
            columns={p.columns}
            disabledRows={p.disabledRows}
            drawFocusRing={p.drawFocusRing}
            drawHeader={p.drawHeader}
            drawCell={drawCell}
            enableGroups={p.enableGroups}
            eventTargetRef={p.eventTargetRef}
            experimental={p.experimental}
            fillHandle={p.fillHandle}
            firstColAccessible={p.firstColAccessible}
            fixedShadowX={p.fixedShadowX}
            fixedShadowY={p.fixedShadowY}
            freezeColumns={p.freezeColumns}
            getCellRenderer={p.getCellRenderer}
            getGroupDetails={p.getGroupDetails}
            getRowThemeOverride={p.getRowThemeOverride}
            groupHeaderHeight={p.groupHeaderHeight}
            headerHeight={p.headerHeight}
            headerIcons={p.headerIcons}
            height={p.height}
            highlightRegions={p.highlightRegions}
            imageWindowLoader={p.imageWindowLoader}
            resizeColumn={resizeCol}
            isDraggable={p.isDraggable}
            isFilling={p.isFilling}
            isFocused={p.isFocused}
            onCanvasBlur={p.onCanvasBlur}
            onCanvasFocused={p.onCanvasFocused}
            onCellFocused={p.onCellFocused}
            onContextMenu={p.onContextMenu}
            onDragEnd={p.onDragEnd}
            onDragLeave={p.onDragLeave}
            onDragOverCell={p.onDragOverCell}
            onDrop={p.onDrop}
            onKeyDown={p.onKeyDown}
            onKeyUp={p.onKeyUp}
            onMouseMove={onMouseMoveImpl}
            mergedCells={p.mergedCells}
            prelightCells={p.prelightCells}
            rowHeight={p.rowHeight}
            rows={p.rows}
            selection={p.selection}
            smoothScrollX={p.smoothScrollX}
            smoothScrollY={p.smoothScrollY}
            theme={p.theme}
            freezeTrailingRows={p.freezeTrailingRows}
            hasAppendRow={p.hasAppendRow}
            translateX={p.translateX}
            translateY={p.translateY}
            verticalBorder={p.verticalBorder}
            width={p.width}
            getCellContent={getCellContent}
            isResizing={resizeCol !== undefined}
            onHeaderMenuClick={onHeaderMenuClickMangled}
            isDragging={dragColActive || dragRowActive}
            isDragRefused={rowMoveRefused}
            onItemHovered={onItemHoveredImpl}
            onDragStart={onDragStartImpl}
            onMouseDown={onMouseDownImpl}
            allowResize={canResize}
            onMouseUp={onMouseUpImpl}
            dragAndDropState={dragOffset}
            onMouseMoveRaw={onMouseMove}
            ref={gridRef}
        />
    );
};

export default DataGridDnd;
