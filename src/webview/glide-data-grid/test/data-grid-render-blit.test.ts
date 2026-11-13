import { describe, expect, test } from "vitest";
import type { MappedGridColumn } from "../internal/data-grid/render/data-grid-lib.js";
import {
    blitResizedCol,
    computeCanBlit,
    type BlitData,
} from "../internal/data-grid/render/data-grid-render.blit.js";
import type { DrawGridArg } from "../internal/data-grid/render/draw-grid-arg.js";

const LAST: BlitData = {
    cellXOffset: 0,
    cellYOffset: 0,
    translateX: 0,
    translateY: 0,
    mustDrawFocusOnHeader: false,
    mustDrawHighlightRingsOnHeader: false,
    lastBuffer: undefined,
    aBufferScroll: undefined,
    bBufferScroll: undefined,
};

function column(sourceIndex: number): MappedGridColumn {
    return {
        sourceIndex,
        sticky: false,
        title: String(sourceIndex),
        width: 100,
        group: "",
        grow: 0,
        hasMenu: false,
        icon: undefined,
        id: undefined,
        menuIcon: undefined,
        overlayIcon: undefined,
        style: "normal",
        themeOverride: undefined,
        trailingRowOptions: undefined,
        growOffset: 0,
        rowMarker: undefined,
        rowMarkerChecked: false,
    };
}

describe("column-resize blitting", () => {
    test("redraws from a merged cell anchor before the resized covered column", () => {
        const columns = Array.from({ length: 5 }, (_, index) => column(index));

        expect(blitResizedCol(
            LAST,
            0,
            0,
            0,
            0,
            500,
            300,
            36,
            columns,
            1,
        )).toEqual([{ x: 101, y: 0, width: 399, height: 300 }]);
    });

    test("starts at the viewport edge when the merged cell anchor is offscreen", () => {
        const columns = [column(3), column(4)];

        expect(blitResizedCol(
            { ...LAST, cellXOffset: 3 },
            3,
            0,
            0,
            0,
            200,
            300,
            36,
            columns,
            1,
        )).toEqual([{ x: 1, y: 0, width: 199, height: 300 }]);
    });
});

describe("blitting after a draw callback change", () => {
    test("redraws rather than reusing pixels painted by another drawCell", () => {
        const columns = [column(0)];
        const base = { width: 500, height: 300, mappedColumns: columns, drawCellCallback: undefined } as unknown as DrawGridArg;
        expect(computeCanBlit({ ...base }, base)).not.toBe(false);
        expect(computeCanBlit({ ...base, drawCellCallback: () => undefined } as DrawGridArg, base)).toBe(false);
    });
});
