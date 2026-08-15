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
    afterEach(async () => {
        await act(async () => {
            cleanup();
        });
    });

    test("renders without crashing with 2D merges in view", async () => {
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

    test("renders a merge whose anchor is above the viewport", async () => {
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

    test("damage draw repaints merges without crashing", async () => {
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

    test("merge-free grids accept and ignore an empty mergedRanges array", async () => {
        vi.useFakeTimers();
        render(<DataEditor {...basicProps} mergedRanges={[]} />, { wrapper: Context });
        prep();
        expect(document.body.contains(screen.getByTestId("data-grid-canvas"))).toBe(true);
    });
});
