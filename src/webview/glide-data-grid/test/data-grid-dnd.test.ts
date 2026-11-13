import { describe, expect, test } from "vitest";
import {
    COLUMN_RESIZE_EDGE_SCROLL_MAX_PX_PER_SECOND,
    columnResizeEdgeScrollDistance,
    columnResizeEdgeScrollDistanceBeforeMax,
    columnResizeEdgeScrollSpeed,
    columnMoveScrollDirection,
    columnResizeWidthFromPointer,
    rowMoveBlockForPress,
    rowMoveDropBefore,
    rowMoveIsNoOp,
    rowMoveScrollDirection,
} from "../internal/data-grid-dnd/data-grid-dnd.js";
import { CompactSelection } from "../internal/data-grid/data-grid-types.js";

describe("column resize edge scrolling", () => {
    test("ramps only inside the right-edge activation zone", () => {
        expect(columnResizeEdgeScrollSpeed(976, 1000)).toBe(0);
        expect(columnResizeEdgeScrollSpeed(977, 1000)).toBe(60);
        expect(columnResizeEdgeScrollSpeed(988, 1000)).toBe(180);
        expect(columnResizeEdgeScrollSpeed(1000, 1000)).toBe(
            COLUMN_RESIZE_EDGE_SCROLL_MAX_PX_PER_SECOND
        );
        expect(columnResizeEdgeScrollSpeed(1010, 1000)).toBe(
            COLUMN_RESIZE_EDGE_SCROLL_MAX_PX_PER_SECOND
        );
    });

    test("normalizes travel for elapsed time and caps long frames", () => {
        expect(columnResizeEdgeScrollDistance(1000, 1000, 1000 / 120)).toBeCloseTo(6);
        expect(columnResizeEdgeScrollDistance(1000, 1000, 1000 / 60)).toBeCloseTo(12);
        expect(columnResizeEdgeScrollDistance(1000, 1000, 1000 / 30)).toBeCloseTo(24);
        expect(columnResizeEdgeScrollDistance(1000, 1000, 1000)).toBe(36);
    });

    test("does not scroll farther than the remaining width before the maximum", () => {
        expect(columnResizeEdgeScrollDistanceBeforeMax(12, 3195, 3200)).toBe(5);
        expect(columnResizeEdgeScrollDistanceBeforeMax(12, 3200, 3200)).toBe(0);
    });

    test("adds consumed scroll distance to physical pointer travel", () => {
        expect(columnResizeWidthFromPointer(500, 300, 40, 40, 1)).toBe(200);
        expect(columnResizeWidthFromPointer(500, 300, 75, 40, 1)).toBe(235);
        expect(columnResizeWidthFromPointer(500, 300, 80, 40, 2)).toBe(140);
    });
});

describe("row move", () => {
    test("arms only for a press inside one contiguous row interval", () => {
        const block = CompactSelection.fromSingleSelection([3, 7]);
        expect(rowMoveBlockForPress(block, 3)).toEqual({ start: 3, end: 6 });
        expect(rowMoveBlockForPress(block, 6)).toEqual({ start: 3, end: 6 });
        expect(rowMoveBlockForPress(block, 7)).toBeUndefined();
        expect(rowMoveBlockForPress(block, 2)).toBeUndefined();
        expect(rowMoveBlockForPress(CompactSelection.empty(), 0)).toBeUndefined();
        expect(rowMoveBlockForPress(block.add(9), 4)).toBeUndefined();
    });

    test("lands before the hovered row in its upper half and after it in its lower half", () => {
        expect(rowMoveDropBefore(4, 100, 100, 30)).toBe(4);
        expect(rowMoveDropBefore(4, 114, 100, 30)).toBe(4);
        expect(rowMoveDropBefore(4, 115, 100, 30)).toBe(5);
        expect(rowMoveDropBefore(4, 129, 100, 30)).toBe(5);
    });

    test("treats a drop inside or beside the block as no move", () => {
        const rows = { start: 3, end: 5 };
        expect(rowMoveIsNoOp(rows, 2)).toBe(false);
        expect(rowMoveIsNoOp(rows, 3)).toBe(true);
        expect(rowMoveIsNoOp(rows, 6)).toBe(true);
        expect(rowMoveIsNoOp(rows, 7)).toBe(false);
    });

    test("scrolls within one row height of the top or bottom edge", () => {
        expect(rowMoveScrollDirection(10, 36, 600, 32)).toBe(-1);
        expect(rowMoveScrollDirection(67, 36, 600, 32)).toBe(-1);
        expect(rowMoveScrollDirection(68, 36, 600, 32)).toBe(0);
        expect(rowMoveScrollDirection(568, 36, 600, 32)).toBe(0);
        expect(rowMoveScrollDirection(569, 36, 600, 32)).toBe(1);
        expect(rowMoveScrollDirection(700, 36, 600, 32)).toBe(1);
    });

    test("never reverses a drag when a row is taller than half the viewport", () => {
        // A 900 px row over a 564 px body: each zone is capped at half of it.
        expect(rowMoveScrollDirection(599, 36, 600, 900)).toBe(1);
        expect(rowMoveScrollDirection(37, 36, 600, 900)).toBe(-1);
        expect(rowMoveScrollDirection(318, 36, 600, 900)).toBe(0);
    });
});

describe("column move auto-scroll", () => {
    test("scrolls within one column width of the left or right edge", () => {
        expect(columnMoveScrollDirection(40, 32, 800, 100)).toBe(-1);
        expect(columnMoveScrollDirection(131, 32, 800, 100)).toBe(-1);
        expect(columnMoveScrollDirection(132, 32, 800, 100)).toBe(0);
        expect(columnMoveScrollDirection(700, 32, 800, 100)).toBe(0);
        expect(columnMoveScrollDirection(701, 32, 800, 100)).toBe(1);
    });

    test("never reverses a drag when a column is wider than half the viewport", () => {
        // frozenRight 32, viewportRight 800, a 900 px column: the pointer at
        // the right edge scrolls right, at the left edge left.
        expect(columnMoveScrollDirection(799, 32, 800, 900)).toBe(1);
        expect(columnMoveScrollDirection(33, 32, 800, 900)).toBe(-1);
        expect(columnMoveScrollDirection(416, 32, 800, 900)).toBe(0);
    });
});
