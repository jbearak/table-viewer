import { describe, expect, test } from "vitest";
import {
    COLUMN_RESIZE_EDGE_SCROLL_MAX_PX_PER_SECOND,
    columnResizeEdgeScrollDistance,
    columnResizeEdgeScrollDistanceBeforeMax,
    columnResizeEdgeScrollSpeed,
    columnResizeWidthFromPointer,
} from "../internal/data-grid-dnd/data-grid-dnd.js";

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
