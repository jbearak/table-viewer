/* eslint-disable sonarjs/no-duplicate-string */
import { getDataEditorTheme, mergeAndRealizeTheme, type FullTheme } from "../common/styles.js";
import {
    remapForDnDState,
    type MappedGridColumn,
    clearTextMetricsCache,
    drawLastUpdateUnderlay,
    drawTextCell,
    splitMultiLineText,
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

describe("splitMultiLineText", () => {
    beforeEach(() => clearTextMetricsCache());

    /** "W" is 29px, "i" 2px, every other glyph 10px. */
    const ctx = {
        font: "",
        measureText: (text: string) => ({
            width: [...text].reduce((width, glyph) => width + (glyph === "W" ? 29 : glyph === "i" ? 2 : 10), 0),
        }),
    } as unknown as CanvasRenderingContext2D;

    it("gives a glyph wider than the line a line of its own, and wraps the rest at the real width", () => {
        // canvas-hypertxt never returns here: its break search makes no progress.
        expect(splitMultiLineText(ctx, "Wabc def", "13px test", 24)).toEqual(["W", "ab", "c", "de", "f"]);
    });

    it("breaks after the last space that fits, and inside a word only when it must", () => {
        expect(splitMultiLineText(ctx, "alpha beta\n\ngamma", "13px test", 60))
            .toEqual(["alpha", "beta", "", "gamma"]);
        expect(splitMultiLineText(ctx, "ab abcdefgh", "13px test", 50)).toEqual(["ab", "abcde", "fgh"]);
        expect(splitMultiLineText(ctx, "  lead and trail  ", "13px test", 1000)).toEqual(["  lead and trail"]);
        // Spaces past the edge add no line, and a line of spaces is one blank line.
        expect(splitMultiLineText(ctx, "aaa bbb   ", "13px test", 70)).toEqual(["aaa bbb"]);
        expect(splitMultiLineText(ctx, "aaa bbb   \nccc", "13px test", 70)).toEqual(["aaa bbb", "ccc"]);
        expect(splitMultiLineText(ctx, "x\n" + " ".repeat(30), "13px test", 70)).toEqual(["x", ""]);
    });

    it("measures each candidate line whole, so kerning across glyphs counts", () => {
        // "AV" kerns 4px tighter than its glyphs summed.
        const kerned = {
            font: "",
            direction: "inherit",
            measureText: (text: string) => ({ width: text.length * 10 - 4 * (text.split("AV").length - 1) }),
        } as unknown as CanvasRenderingContext2D;
        expect(splitMultiLineText(kerned, "AVAVAV AVAVAV", "13px test", 50)).toEqual(["AVAVAV", "AVAVAV"]);
    });

    it("wraps in the context's direction, and keeps each direction's wrap apart", () => {
        const directed = {
            font: "",
            direction: "inherit",
            measureText(this: { direction: string }, text: string) {
                return { width: text.length * 10 + (this.direction === "rtl" ? 5 : 0) };
            },
        } as unknown as CanvasRenderingContext2D;
        expect(splitMultiLineText(directed, "abc def", "13px test", 70)).toEqual(["abc def"]);
        directed.direction = "rtl";
        expect(splitMultiLineText(directed, "abc def", "13px test", 70)).toEqual(["abc", "def"]);
    });

    it("breaks a long unbroken value with a few measurements a line, not one a glyph", () => {
        let calls = 0;
        const counted = {
            font: "",
            measureText: (text: string) => {
                calls += 1;
                return { width: text.length * 10 };
            },
        } as unknown as CanvasRenderingContext2D;
        const word = "abcdefghij".repeat(1_000);
        const lines = splitMultiLineText(counted, word, "13px test", 1_000);
        expect(lines).toHaveLength(100);
        expect(lines.join("")).toBe(word);
        for (const line of lines) expect(line).toHaveLength(100);
        // 10,000 glyphs; about 15 measurements for each of the 100 lines.
        expect(calls).toBeLessThan(2_000);
    });

    it("splits a value of millions of characters without running out of stack", () => {
        const flat = {
            font: "",
            measureText: (text: string) => ({ width: text.length }),
        } as unknown as CanvasRenderingContext2D;
        const lines = splitMultiLineText(flat, "a".repeat(10_000_000), "13px test", 1_000_000);
        expect(lines).toHaveLength(10);
    });

    it("wraps a value into more lines than a spread can pass", () => {
        const lines = splitMultiLineText(ctx, "ab ".repeat(150_000), "13px test", 25);
        expect(lines).toHaveLength(150_000);
    });

    it("adds no line for whitespace: tabs past the edge, or indentation wider than the line", () => {
        expect(splitMultiLineText(ctx, "hi" + "\t".repeat(40), "13px test", 52)).toEqual(["hi"]);
        // Runs of indentation alone add nothing; what is left of it stays on the first line.
        expect(splitMultiLineText(ctx, " ".repeat(12) + "abcdefgh", "13px test", 50)).toEqual(["  abc", "defgh"]);
        expect(splitMultiLineText(ctx, "ab\tcd ef", "13px test", 50)).toEqual(["ab\tcd", "ef"]);
        // A no-break space keeps its words together: "10\u00a0km" moves whole.
        expect(splitMultiLineText(ctx, "abc 10\u00a0km", "13px test", 60)).toEqual(["abc", "10\u00a0km"]);
    });

    it("keeps no state from earlier text that could change a later wrap", () => {
        // canvas-hypertxt judged a line from a prefix sized by the average
        // glyph width of earlier text: after wide text, a long line of narrow
        // glyphs passed as one line. Guards against that coming back.
        const narrow = Array.from({ length: 40 }, () => "iiiiiiiiii").join(" ");
        const fresh = splitMultiLineText(ctx, narrow, "13px test", 104);
        clearTextMetricsCache();
        splitMultiLineText(ctx, "WWWWWWWWWW WWWWWWWWWW WWWWWWWWWW", "13px test", 104);
        expect(splitMultiLineText(ctx, narrow, "13px test", 104)).toEqual(fresh);
        expect(fresh.length).toBeGreaterThan(1);
        for (const line of fresh) expect(ctx.measureText(line).width).toBeLessThanOrEqual(104);
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
