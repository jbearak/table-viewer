import * as React from "react";
import { act, render, fireEvent, screen, cleanup } from "@testing-library/react";
import DataGrid, { type DataGridProps, type DataGridRef } from "../internal/data-grid/data-grid.js";
import { CompactSelection, GridCellKind } from "../internal/data-grid/data-grid-types.js";
import { getDefaultTheme, getMiddleCenterBias, measureTextCached } from "../index.js";
import { AllCellRenderers } from "../cells/index.js";
import { vi, expect, describe, test, beforeEach, afterEach } from "vitest";
import ImageWindowLoaderImpl from "../common/image-window-loader.js";
import { mergeAndRealizeTheme } from "../common/styles.js";
import { MergedCellResolver } from "../internal/data-grid/merged-cell-resolver.js";

const basicProps: DataGridProps = {
    cellXOffset: 0,
    cellYOffset: 0,
    headerIcons: undefined,
    mergedCells: undefined,
    isDraggable: undefined,
    onCanvasBlur: () => undefined,
    onCanvasFocused: () => undefined,
    onCellFocused: () => undefined,
    onContextMenu: () => undefined,
    onDragEnd: () => undefined,
    onDragLeave: () => undefined,
    onDragOverCell: () => undefined,
    onDragStart: () => undefined,
    onDrop: () => undefined,
    onItemHovered: () => undefined,
    onKeyDown: () => undefined,
    onKeyUp: () => undefined,
    onMouseDown: () => undefined,
    onMouseMoveRaw: () => undefined,
    onMouseUp: () => undefined,
    smoothScrollX: undefined,
    smoothScrollY: undefined,
    allowResize: undefined,
    canvasRef: undefined,
    disabledRows: undefined,
    eventTargetRef: undefined,
    fillHandle: undefined,
    fixedShadowX: undefined,
    fixedShadowY: undefined,
    getGroupDetails: undefined,
    getRowThemeOverride: undefined,
    highlightRegions: undefined,
    imageWindowLoader: new ImageWindowLoaderImpl(),
    onHeaderMenuClick: undefined,
    prelightCells: undefined,
    translateX: undefined,
    translateY: undefined,
    dragAndDropState: undefined,
    drawFocusRing: true,
    drawHeader: undefined,
    drawCell: undefined,
    isFocused: true,
    experimental: undefined,
    columns: [
        {
            title: "A",
            width: 150,
        },
        {
            title: "B",
            width: 160,
        },
        {
            title: "C",
            width: 170,
        },
        {
            title: "D",
            width: 180,
        },
        {
            title: "E",
            width: 190,
        },
    ],
    isFilling: false,
    enableGroups: false,
    theme: mergeAndRealizeTheme(getDefaultTheme()),
    freezeColumns: 0,
    selection: {
        current: undefined,
        rows: CompactSelection.empty(),
        columns: CompactSelection.empty(),
    },
    firstColAccessible: true,
    onMouseMove: () => undefined,
    getCellContent: cell => ({
        kind: GridCellKind.Text,
        allowOverlay: false,
        data: `${cell[0]},${cell[1]}`,
        displayData: `${cell[0]},${cell[1]}`,
    }),
    groupHeaderHeight: 0,
    headerHeight: 36,
    accessibilityHeight: 50,
    height: 1000,
    width: 1000,
    isDragging: false,
    isResizing: false,
    resizeColumn: undefined,
    freezeTrailingRows: 0,
    hasAppendRow: false,
    rowHeight: 32,
    rows: 1000,
    verticalBorder: () => true,
    getCellRenderer: cell => {
        if (cell.kind === GridCellKind.Custom) return undefined;
        return AllCellRenderers.find(x => x.kind === cell.kind) as any;
    },
};

const dataGridCanvasId = "data-grid-canvas";
describe("data-grid", () => {
    beforeEach(() => {
        Element.prototype.getBoundingClientRect = () => ({
            bottom: 1000,
            height: 1000,
            left: 0,
            right: 1000,
            top: 0,
            width: 1000,
            x: 0,
            y: 0,
            toJSON: () => "",
        });
        Image.prototype.decode = vi.fn();
    });

    afterEach(() => {
        cleanup();
    });

    test("Emits mouse down", () => {
        const spy = vi.fn();
        render(<DataGrid {...basicProps} onMouseDown={spy} />);

        fireEvent.mouseDown(screen.getByTestId(dataGridCanvasId), {
            clientX: 300, // Col B
            clientY: 36 + 32 + 16, // Row 1 (0 indexed)
        });

        fireEvent.mouseUp(screen.getByTestId(dataGridCanvasId), {
            clientX: 300, // Col B
            clientY: 36 + 32 + 16, // Row 1 (0 indexed)
        });

        fireEvent.click(screen.getByTestId(dataGridCanvasId), {
            clientX: 300, // Col B
            clientY: 36 + 32 + 16, // Row 1 (0 indexed)
        });

        expect(spy).toHaveBeenCalled();
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                location: [1, 1],
                kind: "cell",
            })
        );
    });

    test("OOB mouse down", () => {
        const spy = vi.fn();
        render(<DataGrid {...basicProps} onMouseDown={spy} />);

        fireEvent.mouseDown(screen.getByTestId(dataGridCanvasId), {
            clientX: 990, // Col B
            clientY: 36 + 32 + 16, // Row 1 (0 indexed)
        });

        expect(spy).toHaveBeenCalled();
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "out-of-bounds",
            })
        );
    });

    test("Emits mouse up", () => {
        const spy = vi.fn();
        render(<DataGrid {...basicProps} onMouseUp={spy} />);

        fireEvent.mouseDown(screen.getByTestId(dataGridCanvasId), {
            clientX: 300, // Col B
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        fireEvent.mouseUp(screen.getByTestId(dataGridCanvasId), {
            clientX: 300, // Col B
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        fireEvent.click(screen.getByTestId(dataGridCanvasId), {
            clientX: 300, // Col B
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                location: [1, 5],
                kind: "cell",
                localEventX: 150,
                localEventY: 16,
            }),
            false
        );
    });

    test("Does not emit mousedown/up over header menu", () => {
        const downSpy = vi.fn();
        const upSpy = vi.fn();

        render(
            <DataGrid
                {...basicProps}
                columns={basicProps.columns.map(c => ({ ...c, hasMenu: true }))}
                onMouseUp={upSpy}
                onMouseDown={downSpy}
            />
        );

        const el = screen.getByTestId(dataGridCanvasId);
        fireEvent.mouseDown(el, {
            clientX: 140,
            clientY: 18,
        });

        fireEvent.mouseUp(el, {
            clientX: 140,
            clientY: 18,
        });

        expect(downSpy).not.toBeCalled();
        expect(upSpy).not.toBeCalled();
    });

    test("Cell hovered", () => {
        const spy = vi.fn();

        render(<DataGrid {...basicProps} onItemHovered={spy} />);

        const el = screen.getByTestId(dataGridCanvasId);
        fireEvent.mouseMove(el, {
            clientX: 350, // Col C
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        expect(spy).toBeCalledWith(
            expect.objectContaining({
                kind: "cell",
                location: [2, 5],
            })
        );
    });

    test("Cell is not hovered when target is not data grid", () => {
        const spy = vi.fn();

        render(
            <>
                <DataGrid {...basicProps} onItemHovered={spy} />
                <div
                    data-testid="outside-element"
                    style={{
                        position: "absolute",
                        width: "100vh",
                        height: "100vh",
                    }}
                />
            </>
        );

        const outsideElement = screen.getByTestId("outside-element");
        fireEvent.mouseMove(outsideElement, {
            clientX: 350, // Col C
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        expect(spy).not.toHaveBeenCalled();
    });

    test("Header hovered", () => {
        const spy = vi.fn();

        render(<DataGrid {...basicProps} onItemHovered={spy} />);

        const el = screen.getByTestId(dataGridCanvasId);
        fireEvent.mouseMove(el, {
            clientX: 350, // Col C
            clientY: 16, // Header
        });

        expect(spy).toBeCalledWith(
            expect.objectContaining({
                kind: "header",
                location: [2, -1],
            })
        );
    });

    test("Header hovered when scrolled", () => {
        const spy = vi.fn();

        render(
            <DataGrid {...basicProps} groupHeaderHeight={32} enableGroups={true} cellYOffset={10} onItemHovered={spy} />
        );

        const el = screen.getByTestId(dataGridCanvasId);
        fireEvent.mouseMove(el, {
            clientX: 350, // Col C
            clientY: 46, // Header
        });

        expect(spy).toBeCalledWith(
            expect.objectContaining({
                kind: "header",
                location: [2, -1],
            })
        );
    });

    test("Group header hovered", () => {
        const spy = vi.fn();

        render(<DataGrid {...basicProps} onItemHovered={spy} enableGroups={true} groupHeaderHeight={28} />);

        const el = screen.getByTestId(dataGridCanvasId);
        fireEvent.mouseMove(el, {
            clientX: 350, // Col C
            clientY: 14, // Header
        });

        expect(spy).toBeCalledWith(
            expect.objectContaining({
                kind: "group-header",
                location: [2, -2],
            })
        );
    });

    test("Redraws after a later web-font load completes", async () => {
        const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
        let ready = Promise.resolve({} as FontFaceSet);
        const fonts = new EventTarget();
        Object.defineProperty(fonts, "ready", { get: () => ready });
        Object.defineProperty(document, "fonts", {
            configurable: true,
            value: fonts,
        });
        const spy = vi.fn(basicProps.getCellContent);

        try {
            await act(async () => {
                render(<DataGrid {...basicProps} getCellContent={spy} />);
                await ready;
            });
            spy.mockClear();

            let measuredWidth = 10;
            const measureContext = {
                font: "13px FontCycleProbe",
                measureText: () => ({ width: measuredWidth }) as TextMetrics,
            } as unknown as CanvasRenderingContext2D;
            expect(measureTextCached(
                "font-ready-cache-probe",
                measureContext,
                measureContext.font,
            ).width).toBe(10);

            let finalBiasMetrics = false;
            let textBaseline: CanvasTextBaseline = "middle";
            const biasContext = {
                font: "13px FontCycleBiasProbe",
                get textBaseline() {
                    return textBaseline;
                },
                set textBaseline(value: CanvasTextBaseline) {
                    textBaseline = value;
                },
                save: () => undefined,
                restore: () => undefined,
                measureText: () => ({
                    actualBoundingBoxAscent: finalBiasMetrics ? 10 : 8,
                    actualBoundingBoxDescent: textBaseline === "middle"
                        ? (finalBiasMetrics ? 4 : 3)
                        : (finalBiasMetrics ? 2 : 1),
                }) as TextMetrics,
            } as unknown as CanvasRenderingContext2D;
            expect(getMiddleCenterBias(biasContext, biasContext.font)).toBe(2);

            // A later face/weight gets its own FontFaceSet.ready promise. The
            // completion event must clear fallback width and alignment metrics,
            // then trigger a grid draw without user damage.
            measuredWidth = 20;
            finalBiasMetrics = true;
            ready = Promise.resolve({} as FontFaceSet);
            await act(async () => {
                fonts.dispatchEvent(new Event("loadingdone"));
                await ready;
            });

            expect(spy).toHaveBeenCalled();
            expect(measureTextCached(
                "font-ready-cache-probe",
                measureContext,
                measureContext.font,
            ).width).toBe(20);
            expect(getMiddleCenterBias(biasContext, biasContext.font)).toBe(3);
        } finally {
            cleanup();
            if (fontsDescriptor) {
                Object.defineProperty(document, "fonts", fontsDescriptor);
            } else {
                Reflect.deleteProperty(document, "fonts");
            }
        }
    });

    test("Simple damage", () => {
        const spy = vi.fn(basicProps.getCellContent);
        const ref = React.createRef<DataGridRef>();

        render(<DataGrid ref={ref} {...basicProps} getCellContent={spy} enableGroups={true} groupHeaderHeight={28} />);

        spy.mockClear();
        expect(spy).not.toBeCalled();
        ref.current?.damage([{ cell: [1, 1] }]);
        expect(spy).toBeCalled();
    });

    test("column resize repaints a wrapped merge from its visible anchor", () => {
        const columns = [
            { title: "A", width: 150 },
            { title: "B", width: 160 },
            { title: "C", width: 170 },
            { title: "D", width: 180 },
            { title: "E", width: 190 },
        ];
        const mergedCells = new MergedCellResolver([
            { x: 1, y: 7, width: 4, height: 1 },
        ]);
        const getCellContent: DataGridProps["getCellContent"] = ([col, row]) => ({
            kind: GridCellKind.Text,
            allowOverlay: false,
            allowWrapping: col === 1 && row === 7,
            data: col === 1 && row === 7
                ? "A long information note that soft wraps across the merged columns"
                : `${col},${row}`,
            displayData: col === 1 && row === 7
                ? "A long information note that soft wraps across the merged columns"
                : `${col},${row}`,
        });
        const { rerender } = render(
            <DataGrid
                {...basicProps}
                columns={columns}
                getCellContent={getCellContent}
                mergedCells={mergedCells}
                isResizing={true}
                resizeColumn={2}
            />
        );
        const ctx = screen.getByTestId<HTMLCanvasElement>(dataGridCanvasId).getContext("2d");
        expect(ctx).not.toBeNull();
        const rect = vi.spyOn(ctx!, "rect");

        rerender(
            <DataGrid
                {...basicProps}
                columns={columns.map((column, index) => (
                    index === 2 ? { ...column, width: 220 } : column
                ))}
                getCellContent={getCellContent}
                mergedCells={mergedCells}
                isResizing={true}
                resizeColumn={2}
            />
        );

        // Resizing C changes the wrap width of B8:E8. The resize blit must
        // therefore repaint from B's left edge (150 + the one-pixel border),
        // not C's old left edge at 310.
        expect(rect).toHaveBeenCalledWith(151, 0, 849, 1000);
    });

    test("Out of bounds damage", () => {
        const spy = vi.fn(basicProps.getCellContent);
        const ref = React.createRef<DataGridRef>();

        render(<DataGrid ref={ref} {...basicProps} getCellContent={spy} enableGroups={true} groupHeaderHeight={28} />);

        spy.mockClear();
        expect(spy).not.toBeCalled();
        ref.current?.damage([{ cell: [1, 900] }]);
        expect(spy).not.toBeCalled();
    });

    test("Freeze column simple check", () => {
        const spy = vi.fn();
        render(<DataGrid {...basicProps} freezeColumns={1} cellXOffset={3} onMouseUp={spy} />);

        fireEvent.mouseDown(screen.getByTestId(dataGridCanvasId), {
            clientX: 50, // Col A
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        fireEvent.mouseUp(screen.getByTestId(dataGridCanvasId), {
            clientX: 50, // Col A
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        fireEvent.click(screen.getByTestId(dataGridCanvasId), {
            clientX: 50, // Col A
            clientY: 36 + 32 * 5 + 16, // Row 5 (0 indexed)
        });

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                location: [0, 5],
                kind: "cell",
                localEventX: 50,
                localEventY: 16,
            }),
            false
        );
    });
});
