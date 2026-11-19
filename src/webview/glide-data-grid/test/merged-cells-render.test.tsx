// Fork addition: Stage-2 rendering tests for mergedRanges. The draw loop is
// canvas-based, so these tests verify the pipeline runs the merge path
// without crashing (full draw, scrolled draw, damage draw) rather than
// asserting pixels; resolver semantics are covered in
// merged-cell-resolver.test.ts.
import * as React from "react";
import { render, fireEvent, screen, act, cleanup } from "@testing-library/react";
import { DataEditor, GridCellKind, type DataEditorProps, type GridCell, type Item } from "../index.js";
import type { DataEditorRef } from "../data-editor/data-editor.js";
import { vi, expect, describe, test, afterEach } from "vitest";

vi.mock("../common/resize-detector", () => {
    return {
        useResizeDetector: () => ({ ref: undefined, width: 1000, height: 800 }),
    };
});

const COLS = 10;
const ROWS = 100;

function getCellContent([col, row]: Item): GridCell {
    return {
        kind: GridCellKind.Text,
        allowOverlay: true,
        data: `${col}, ${row}`,
        displayData: `${col}, ${row}`,
    };
}

const basicProps: Partial<DataEditorProps> & {
    columns: DataEditorProps["columns"];
    rows: number;
    getCellContent: DataEditorProps["getCellContent"];
} = {
    columns: Array.from({ length: COLS }, (_, i) => ({ title: String.fromCharCode(65 + i), width: 100 })),
    rows: ROWS,
    getCellContent,
};

const Context: React.FC<React.PropsWithChildren> = p => (
    <>
        {p.children}
        <div id="portal"></div>
    </>
);

function prep() {
    const scroller = document.getElementsByClassName("dvn-scroller").item(0);
    if (scroller !== null) {
        vi.spyOn(scroller, "clientWidth", "get").mockImplementation(() => 1000);
        vi.spyOn(scroller, "clientHeight", "get").mockImplementation(() => 800);
        vi.spyOn(scroller, "offsetWidth" as any, "get").mockImplementation(() => 1000);
        vi.spyOn(scroller, "offsetHeight" as any, "get").mockImplementation(() => 800);
    }
    act(() => {
        vi.runAllTimers();
    });
    vi.useRealTimers();
    return scroller;
}

describe("mergedRanges rendering", () => {
    afterEach(() => {
        act(() => {
            cleanup();
        });
    });

    test("renders without crashing with 2D merges in view", () => {
        vi.useFakeTimers();
        render(
            <DataEditor
                {...basicProps}
                mergedRanges={[
                    { x: 1, y: 1, width: 2, height: 3 },
                    { x: 4, y: 0, width: 1, height: 5 },
                ]}
            />,
            { wrapper: Context }
        );
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");
        expect(document.body.contains(canvas)).toBe(true);
    });

    test("renders a merge whose anchor is above the viewport", () => {
        vi.useFakeTimers();
        render(
            <DataEditor
                {...basicProps}
                // 40-row-tall merge; scrolling into its middle leaves the
                // anchor far above the visible region.
                mergedRanges={[{ x: 0, y: 0, width: 2, height: 40 }]}
            />,
            { wrapper: Context }
        );
        const scroller = prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        expect(scroller).not.toBeNull();
        if (scroller !== null) {
            vi.spyOn(scroller, "scrollWidth", "get").mockImplementation(() => 100 * COLS);
            vi.spyOn(scroller, "scrollHeight", "get").mockImplementation(() => ROWS * 33 + 36);
            vi.spyOn(scroller, "scrollLeft", "get").mockImplementation(() => 0);
            vi.spyOn(scroller, "scrollTop", "get").mockImplementation(() => 33 * 20);
            fireEvent.scroll(scroller);
        }

        expect(document.body.contains(canvas)).toBe(true);
    });

    // Fork test: a tall merge's rectangle is the same whether its rows'
    // heights come as a number, a plain callable (walked once) or a callable
    // carrying a prefix index (two prefix differences), anchor above the view.
    test("paints a tall merge at the same rectangle for every kind of row height", () => {
        const height = (r: number) => (r % 3 === 0 ? 40 : 30);
        const top = (row: number) => {
            let sum = 0;
            for (let r = 0; r < row; r++) sum += height(r);
            return sum;
        };
        const indexed = Object.assign((r: number) => height(r), {
            rowHeightIndex: {
                top,
                rowAtY: (y: number) => {
                    let row = 0;
                    while (top(row + 1) <= y) row++;
                    return row;
                },
            },
        });
        const merged_rect = (rowHeight: DataEditorProps["rowHeight"], scroll_top: number) => {
            const rects: { y: number; height: number }[] = [];
            vi.useFakeTimers();
            render(
                <DataEditor
                    {...basicProps}
                    rowHeight={rowHeight}
                    mergedRanges={[{ x: 0, y: 0, width: 1, height: 60 }]}
                    drawCell={args => {
                        if (args.col === 0) rects.push({ y: args.rect.y, height: args.rect.height });
                        return false;
                    }}
                />,
                { wrapper: Context }
            );
            const scroller = prep();
            if (scroller !== null) {
                vi.spyOn(scroller, "scrollTop", "get").mockImplementation(() => scroll_top);
                fireEvent.scroll(scroller);
            }
            act(() => {
                cleanup();
            });
            expect(rects.length).toBeGreaterThan(0);
            return rects[rects.length - 1];
        };
        for (const scroll_top of [0, 700]) {
            const walked = merged_rect(height, scroll_top);
            expect(merged_rect(indexed, scroll_top)).toEqual(walked);
            expect(walked.height).toBe(top(60));
        }
        const uniform = merged_rect(34, 700);
        expect(uniform.height).toBe(60 * 34);
        expect(merged_rect((_r: number) => 34, 700)).toEqual(uniform);
    });

    // Fork test: with an indexed callable a tall merge's height and anchor
    // offset are prefix differences, so painting it asks for no row of it
    // beyond the visible ones.
    test("paints a tall merge without asking for each of its rows' heights", () => {
        const rows = 100_000;
        let calls = 0;
        const height = (r: number) => {
            calls++;
            return r % 2 === 0 ? 40 : 30;
        };
        // Closed form: pairs of 70 px.
        const top = (row: number) => Math.floor(row / 2) * 70 + (row % 2) * 40;
        const indexed = Object.assign((r: number) => height(r), {
            rowHeightIndex: {
                top,
                rowAtY: (y: number) => {
                    if (!(y > 0)) return 0;
                    let row = Math.floor(y / 70) * 2;
                    while (top(row + 1) <= y) row++;
                    return row;
                },
            },
        });
        vi.useFakeTimers();
        render(
            <DataEditor
                {...basicProps}
                rows={rows}
                rowHeight={indexed}
                mergedRanges={[{ x: 0, y: 10, width: 1, height: 50_000 }]}
            />,
            { wrapper: Context }
        );
        const scroller = prep();
        if (scroller !== null) {
            vi.spyOn(scroller, "scrollTop", "get").mockImplementation(() => top(30_000));
            fireEvent.scroll(scroller);
        }
        expect(calls).toBeLessThan(5_000);
    });

    test("damage draw repaints merges without crashing", () => {
        vi.useFakeTimers();
        const ref = React.createRef<DataEditorRef>();
        render(
            <DataEditor {...basicProps} ref={ref} mergedRanges={[{ x: 1, y: 1, width: 3, height: 3 }]} />,
            { wrapper: Context }
        );
        prep();

        // Damage a covered (non-anchor) cell: expansion must repaint the
        // whole merge, including the anchor.
        act(() => {
            ref.current?.updateCells([{ cell: [2, 2] }]);
        });

        const canvas = screen.getByTestId("data-grid-canvas");
        expect(document.body.contains(canvas)).toBe(true);
    });

    test("merge-free grids accept and ignore an empty mergedRanges array", () => {
        vi.useFakeTimers();
        render(<DataEditor {...basicProps} mergedRanges={[]} />, { wrapper: Context });
        prep();
        expect(document.body.contains(screen.getByTestId("data-grid-canvas"))).toBe(true);
    });
});
