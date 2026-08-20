/* eslint-disable sonarjs/no-duplicate-string */
import { getDataEditorTheme, mergeAndRealizeTheme, type FullTheme } from "../common/styles.js";
import {
    remapForDnDState,
    type MappedGridColumn,
    clearTextMetricsCache,
    drawLastUpdateUnderlay,
    drawTextCell,
} from "../internal/data-grid/render/data-grid-lib.js";
import { GridCellKind, type Rectangle } from "../internal/data-grid/data-grid-types.js";
import { vi, type Mocked, expect, describe, test, it, beforeEach } from "vitest";

function makeCol(title: string, sourceIndex: number, sticky: boolean, width: number): MappedGridColumn {
    return {
        title,
        sourceIndex,
        sticky,
        width,
        group: undefined,
        grow: undefined,
        hasMenu: undefined,
        icon: undefined,
        id: undefined,
        menuIcon: undefined,
        overlayIcon: undefined,
        style: undefined,
        themeOverride: undefined,
        trailingRowOptions: undefined,
        growOffset: undefined,
        rowMarker: undefined,
        rowMarkerChecked: undefined,
    };
}

describe("remapForDnDState", () => {
    const sampleColumns: MappedGridColumn[] = [
        makeCol("Column 1", 0, true, 50),
        makeCol("Column 2", 1, false, 60),
        makeCol("Column 3", 2, true, 70),
    ];

    it("should return the same array if dndState is undefined", () => {
        const result = remapForDnDState(sampleColumns);
        expect(result).toEqual(sampleColumns);
    });

    it("should move item from a lower index to a higher index", () => {
        const result = remapForDnDState(sampleColumns, { src: 0, dest: 2 });
        expect(result[2].title).toEqual("Column 1");
    });

    it("should move item from a higher index to a lower index", () => {
        const result = remapForDnDState(sampleColumns, { src: 2, dest: 0 });
        expect(result[0].title).toEqual("Column 3");
    });

    it("should not move item if dragged to its current position", () => {
        const result = remapForDnDState(sampleColumns, { src: 1, dest: 1 });
        expect(result).toEqual(sampleColumns);
    });

    it("should move the first item to the last position", () => {
        const result = remapForDnDState(sampleColumns, { src: 0, dest: 2 });
        expect(result[2].title).toEqual("Column 1");
    });

    it("should move the last item to the first position", () => {
        const result = remapForDnDState(sampleColumns, { src: 2, dest: 0 });
        expect(result[0].title).toEqual("Column 3");
    });

    it("should keep the sticky property unchanged", () => {
        const result = remapForDnDState(sampleColumns, { src: 0, dest: 2 });
        for (const [index, column] of sampleColumns.entries()) {
            expect(result[index].sticky).toEqual(column.sticky);
        }
    });
});

describe("drawTextCell wrapping", () => {
    const makeContext = (drawn: string[]) => ({
        font: "",
        textAlign: "start",
        direction: "inherit",
        measureText: (text: string) => ({
            width: text.length * 10,
            actualBoundingBoxAscent: 8,
            actualBoundingBoxDescent: 2,
        }),
        fillText: (text: string) => drawn.push(text),
        save: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        restore: vi.fn(),
    }) as unknown as CanvasRenderingContext2D;

    beforeEach(() => clearTextMetricsCache());

    it("soft-wraps a Text cell within the supplied cell bounds", () => {
        const drawn: string[] = [];
        const ctx = makeContext(drawn);
        const theme = mergeAndRealizeTheme(getDataEditorTheme());

        drawTextCell(
            {
                ctx,
                rect: { x: 0, y: 0, width: 76, height: 80 },
                theme,
            },
            "alpha beta",
            undefined,
            true,
            false,
        );

        expect(drawn).toEqual(["alpha", "beta"]);
    });

    test.each([
        ["leading", "\nalpha beta", ["", "alpha", "beta"]],
        ["trailing", "alpha beta\n", ["alpha", "beta", ""]],
        ["interior", "alpha beta\n\ngamma delta", ["alpha", "beta", "", "gamma", "delta"]],
        ["consecutive", "alpha beta\n\n\ngamma delta", ["alpha", "beta", "", "", "gamma", "delta"]],
    ])("preserves %s blank hard lines while wrapping", (_name, text, expected) => {
        const drawn: string[] = [];
        const ctx = makeContext(drawn);
        const theme = mergeAndRealizeTheme(getDataEditorTheme());

        drawTextCell(
            { ctx, rect: { x: 0, y: 0, width: 76, height: 120 }, theme },
            text,
            undefined,
            true,
            false,
        );
        expect(drawn).toEqual(expected);
    });

    it("reflows blank-line text when a cell grows and shrinks", () => {
        const drawn: string[] = [];
        const ctx = makeContext(drawn);
        const theme = mergeAndRealizeTheme(getDataEditorTheme());
        const text = "alpha beta\n\ngamma delta";
        const drawAtWidth = (width: number) => {
            drawn.length = 0;
            drawTextCell(
                { ctx, rect: { x: 0, y: 0, width, height: 120 }, theme },
                text,
                undefined,
                true,
                false,
            );
            return [...drawn];
        };

        expect(drawAtWidth(76)).toEqual(["alpha", "beta", "", "gamma", "delta"]);
        expect(drawAtWidth(140)).toEqual(["alpha beta", "", "gamma delta"]);
        expect(drawAtWidth(86)).toEqual(["alpha", "beta", "", "gamma", "delta"]);
    });
});

describe("drawWithLastUpdate", () => {
    const mockCtx: Mocked<CanvasRenderingContext2D> = {} as any;
    let mockTheme: FullTheme;
    let mockRect: Rectangle;

    beforeEach(() => {
        mockCtx.fillRect = vi.fn();
        mockCtx.fillStyle = "";
        mockCtx.globalAlpha = 1;

        mockTheme = mergeAndRealizeTheme(getDataEditorTheme(), { bgSearchResult: "some-color" });

        mockRect = {
            x: 10,
            y: 20,
            width: 50,
            height: 60,
        };
    });

    it("should do nothing if lastUpdate is undefined", () => {
        const result = drawLastUpdateUnderlay(
            {
                ctx: mockCtx,
                theme: mockTheme,
                cellFillColor: mockTheme.bgCell,
                rect: mockRect,
                cell: { kind: GridCellKind.Text, allowOverlay: false, data: "Test", displayData: "Test" },
                col: 0,
                row: 0,
                highlighted: false,
                hoverAmount: 0,
                hoverX: undefined,
                hoverY: undefined,
                hyperWrapping: false,
                imageLoader: {} as any,
                spriteManager: {} as any,
            },
            undefined,
            1000,
            undefined,
            false,
            false
        );

        expect(mockCtx.fillStyle).toBe("");
        expect(result).toBe(false);
    });

    it("should not animate if progress is >= animTime", () => {
        const lastUpdate = 400;
        const frameTime = 1000;

        const result = drawLastUpdateUnderlay(
            {
                ctx: mockCtx,
                theme: mockTheme,
                cellFillColor: mockTheme.bgCell,
                rect: mockRect,
                cell: { kind: GridCellKind.Text, allowOverlay: false, data: "Test", displayData: "Test" },
                col: 0,
                row: 0,
                highlighted: false,
                hoverAmount: 0,
                hoverX: undefined,
                hoverY: undefined,
                hyperWrapping: false,
                imageLoader: {} as any,
                spriteManager: {} as any,
            },
            lastUpdate,
            frameTime,
            undefined,
            false,
            false
        );

        expect(mockCtx.fillStyle).toBe("");
        expect(result).toBe(false);
    });

    it("should animate if progress is < animTime", () => {
        const lastUpdate = 600;
        const frameTime = 1000;

        const result = drawLastUpdateUnderlay(
            {
                ctx: mockCtx,
                theme: mockTheme,
                cellFillColor: mockTheme.bgCell,
                rect: mockRect,
                cell: { kind: GridCellKind.Text, allowOverlay: false, data: "Test", displayData: "Test" },
                col: 0,
                row: 0,
                highlighted: false,
                hoverAmount: 0,
                hoverX: undefined,
                hoverY: undefined,
                hyperWrapping: false,
                imageLoader: {} as any,
                spriteManager: {} as any,
            },
            lastUpdate,
            frameTime,
            undefined,
            false,
            false
        );

        expect(mockCtx.fillStyle).toBe(mockTheme.bgSearchResult);
        expect(mockCtx.fillRect).toHaveBeenCalledWith(
            mockRect.x + 1,
            mockRect.y + 1,
            mockRect.width - 1,
            mockRect.height - 1
        );
        expect(result).toBe(true);
    });

    it("should update lastPrep's fillStyle if defined", () => {
        const lastUpdate = 600;
        const frameTime = 1000;
        const mockLastPrep = { fillStyle: "", deprep: vi.fn(), font: "some-font", renderer: {} };

        drawLastUpdateUnderlay(
            {
                ctx: mockCtx,
                theme: mockTheme,
                cellFillColor: mockTheme.bgCell,
                rect: mockRect,
                cell: { kind: GridCellKind.Text, allowOverlay: false, data: "Test", displayData: "Test" },
                col: 0,
                row: 0,
                highlighted: false,
                hoverAmount: 0,
                hoverX: undefined,
                hoverY: undefined,
                hyperWrapping: false,
                imageLoader: {} as any,
                spriteManager: {} as any,
            },
            lastUpdate,
            frameTime,
            mockLastPrep,
            false,
            false
        );

        expect(mockLastPrep.fillStyle).toBe(mockTheme.bgSearchResult);
    });
});
