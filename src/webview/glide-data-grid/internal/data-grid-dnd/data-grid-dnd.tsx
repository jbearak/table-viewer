/* eslint-disable unicorn/consistent-destructuring */
import { clamp } from "../../common/collection-utils.js";
import * as React from "react";
import DataGrid, { type DataGridProps, type DataGridRef } from "../data-grid/data-grid.js";
import type { GridColumn, InnerGridColumn, Rectangle } from "../data-grid/data-grid-types.js";
import type { GridMouseEventArgs } from "../data-grid/event-args.js";

type Props = Omit<
    DataGridProps,
    "dragAndDropState" | "isResizing" | "isDragging" | "onMouseMoveRaw" | "allowResize" | "resizeColumn"
>;

export interface DataGridDndProps extends Props {
    /**
     * Called whenever a row re-order operation is completed. Setting the callback enables re-ordering by dragging the
     * first column of a row.
     * @group Drag and Drop
     */
    readonly onRowMoved?: (startIndex: number, endIndex: number) => void;
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

    const [dragRow, setDragRow] = React.useState<number>();
    const [dropRow, setDropRow] = React.useState<number>();
    const [dragRowActive, setDragRowActive] = React.useState(false);
    const [dragStartY, setDragStartY] = React.useState<number>();

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
            for (const selected of selectedColumns) {
                if (selected === colIndex) continue;
                const selectedColumn = columns[selected];
                const selectedSize = offsetColumnSize(
                    selectedColumn,
                    rawWidth,
                    minColumnWidth,
                    maxColumnWidth
                );
                onColumnResize?.(
                    selectedColumn,
                    selectedSize,
                    selected,
                    selectedSize + (selectedColumn.growOffset ?? 0)
                );
            }
        }
    }, [
        canvasRef,
        columns,
        eventTargetRef,
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

    resizeEdgeScrollTickRef.current = timestamp => {
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
    };

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
            const [col, row] = args.location;
            if (dragCol !== undefined && dropCol !== col && col >= lockColumns) {
                setDragColActive(true);
                setDropCol(col);
            } else if (dragRow !== undefined && row !== undefined) {
                setDragRowActive(true);
                setDropRow(Math.max(0, row));
            // Don't emit onItemHovered if resizing or reordering a column or row.
            } else if (resizeCol === undefined && !dragColActive && !dragRowActive) {
                onItemHovered?.(args);
            }
        },
        [dragCol, dragRow, dropCol, onItemHovered, lockColumns, resizeCol, dragColActive, dragRowActive]
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
                    onRowMoved !== undefined
                ) {
                    setDragStartY(args.bounds.y);
                    setDragRow(row);
                }
            }
            onMouseDown?.(args);
        },
        [
            onMouseDown,
            canResize,
            lockColumns,
            onRowMoved,
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
        setDragRow(undefined);
        setDropRow(undefined);
        setDragStartY(undefined);
        setDragRowActive(false);
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
            for (const selected of selectedColumns) {
                if (selected === currentResizeCol) continue;
                const selectedColumn = columns[selected];
                const selectedSize = offsetColumnSize(
                    selectedColumn,
                    lastResizeWidthRef.current,
                    minColumnWidth,
                    maxColumnWidth
                );
                onColumnResize?.(
                    selectedColumn,
                    selectedSize,
                    selected,
                    selectedSize + (selectedColumn.growOffset ?? 0)
                );
            }
        }

        const column = columns[currentResizeCol];
        const size = offsetColumnSize(column, lastResizeWidthRef.current, minColumnWidth, maxColumnWidth);
        onColumnResizeEnd?.(column, size, currentResizeCol, size + (column.growOffset ?? 0));
        if (selectedColumns.hasIndex(currentResizeCol)) {
            for (const selected of selectedColumns) {
                if (selected === currentResizeCol) continue;
                const selectedColumn = columns[selected];
                const selectedSize = offsetColumnSize(
                    selectedColumn,
                    lastResizeWidthRef.current,
                    minColumnWidth,
                    maxColumnWidth
                );
                onColumnResizeEnd?.(
                    selectedColumn,
                    selectedSize,
                    selected,
                    selectedSize + (selectedColumn.growOffset ?? 0)
                );
            }
        }
    }, [
        columns,
        maxColumnWidth,
        minColumnWidth,
        onColumnResize,
        onColumnResizeEnd,
        selectedColumns,
    ]);

    const onMouseUpImpl = React.useCallback(
        (args: GridMouseEventArgs, isOutside: boolean) => {
            if (args.button === 0) {
                finishColumnResize();
                clearAll();
                if (dragCol !== undefined && dropCol !== undefined) {
                    onColumnMoved?.(dragCol, dropCol);
                }
                if (dragRow !== undefined && dropRow !== undefined) {
                    onRowMoved?.(dragRow, dropRow);
                }
            }
            onMouseUp?.(args, isOutside);
        },
        [
            onMouseUp,
            dragCol,
            dropCol,
            dragRow,
            dropRow,
            onColumnMoved,
            onRowMoved,
            clearAll,
            finishColumnResize,
        ]
    );

    React.useEffect(() => {
        const finishInterruptedResize = () => {
            if (resizeColRef.current === undefined) return;
            finishColumnResize();
            clearAll();
        };
        const finishResizeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") finishInterruptedResize();
        };
        window.addEventListener("blur", finishInterruptedResize);
        window.addEventListener("pointercancel", finishInterruptedResize);
        window.addEventListener("keydown", finishResizeOnEscape);
        return () => {
            window.removeEventListener("blur", finishInterruptedResize);
            window.removeEventListener("pointercancel", finishInterruptedResize);
            window.removeEventListener("keydown", finishResizeOnEscape);
        };
    }, [clearAll, finishColumnResize]);

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
            if (dragCol !== undefined && dragStartX !== undefined) {
                const diff = Math.abs(event.clientX - dragStartX);
                if (diff > 20) {
                    setDragColActive(true);
                }
            } else if (dragRow !== undefined && dragStartY !== undefined) {
                const diff = Math.abs(event.clientY - dragStartY);
                if (diff > 20) {
                    setDragRowActive(true);
                }
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
            dragRow,
            dragStartY,
            resizeCol,
            columns,
            canvasRef,
            applyColumnResizeAtPointer,
            eventTargetRef,
            scheduleResizeEdgeScroll,
            stopResizeEdgeScroll,
        ]
    );

    const getMangledCellContent = React.useCallback<typeof getCellContent>(
        (cell, forceStrict) => {
            if (dragRow === undefined || dropRow === undefined) return getCellContent(cell, forceStrict);

            // eslint-disable-next-line prefer-const
            let [col, row] = cell;
            if (row === dropRow) {
                row = dragRow;
            } else {
                if (row > dropRow) row -= 1;
                if (row >= dragRow) row += 1;
            }

            return getCellContent([col, row], forceStrict);
        },
        [dragRow, dropRow, getCellContent]
    );

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
            drawCell={p.drawCell}
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
            onMouseMove={p.onMouseMove}
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
            getCellContent={getMangledCellContent}
            isResizing={resizeCol !== undefined}
            onHeaderMenuClick={onHeaderMenuClickMangled}
            isDragging={dragColActive}
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
