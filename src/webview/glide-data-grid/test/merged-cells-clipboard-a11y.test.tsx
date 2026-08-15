// Fork addition: Stage-4 tests for mergedRanges — clipboard semantics
// (covered cells copy as blanks, paste skips covered cells) and the
// accessibility tree (anchor td spans the merge, covered cells omitted).
import * as React from "react";
import { render, fireEvent, screen, act, cleanup } from "@testing-library/react";
import {
    DataEditor,
    GridCellKind,
    type DataEditorProps,
    type GridCell,
    type GridSelection,
    type Item,
} from "../index.js";
import { vi, expect, describe, test, beforeEach, afterEach } from "vitest";

vi.mock("../common/resize-detector", () => {
    return {
        useResizeDetector: () => ({ ref: undefined, width: 1000, height: 800 }),
    };
});

const COLS = 10;
const ROWS = 100;
const COL_WIDTH = 100;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 36;

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
    columns: Array.from({ length: COLS }, (_, i) => ({ title: String.fromCharCode(65 + i), width: COL_WIDTH })),
    rows: ROWS,
    getCellContent,
    getCellsForSelection: true,
    headerHeight: HEADER_HEIGHT,
    rowHeight: ROW_HEIGHT,
};

function cellCenter([col, row]: Item): { clientX: number; clientY: number } {
    return {
        clientX: col * COL_WIDTH + COL_WIDTH / 2,
        clientY: HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2,
    };
}

const Context: React.FC<React.PropsWithChildren> = p => (
    <>
        {p.children}
        <div id="portal"></div>
    </>
);

const EventedDataEditor: React.FC<DataEditorProps> = p => {
    const [sel, setSel] = React.useState<GridSelection | undefined>(p.gridSelection);
    const onGridSelectionChange = React.useCallback(
        (s: GridSelection) => {
            setSel(s);
            p.onGridSelectionChange?.(s);
        },
        [p]
    );
    return <DataEditor {...p} gridSelection={sel} onGridSelectionChange={onGridSelectionChange} />;
};

function prep(resetTimers: boolean = true) {
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
    if (resetTimers) {
        vi.useRealTimers();
    } else {
        act(() => {
            vi.runAllTimers();
        });
    }
    return scroller;
}

function sendClick(el: Element, options: { clientX: number; clientY: number; shiftKey?: boolean }): void {
    fireEvent.mouseDown(el, options);
    fireEvent.mouseUp(el, options);
    fireEvent.click(el, options);
}

// The merge under test: anchor [2,2], spanning columns 2-3 and rows 2-4.
const MERGES = [{ x: 2, y: 2, width: 2, height: 3 }];

describe("mergedRanges clipboard and accessibility", () => {
    beforeEach(() => {
        Element.prototype.scrollTo = vi.fn() as any;
        Element.prototype.scrollBy = vi.fn() as any;
        Object.assign(navigator, {
            clipboard: {
                writeText: vi.fn(() => Promise.resolve()),
                readText: vi.fn(() => Promise.resolve("aa\tbb\ncc\tdd\nee\tff")),
            },
        });
        Element.prototype.getBoundingClientRect = () => ({
            bottom: 800,
            height: 800,
            left: 0,
            right: 1000,
            top: 0,
            width: 1000,
            x: 0,
            y: 0,
            toJSON: () => "",
        });
        Object.defineProperties(HTMLElement.prototype, {
            offsetWidth: {
                get() {
                    return 1000;
                },
            },
        });
    });

    afterEach(() => {
        vi.clearAllTimers();
        act(() => {
            cleanup();
        });
    });

    test("copying a merge yields the anchor value once, covered cells blank", async () => {
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} />, {
            wrapper: Context,
        });
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");
        vi.spyOn(document, "activeElement", "get").mockImplementation(() => canvas);

        // Select [2,2] (the anchor; the range expands to the whole merge),
        // then grow one column right and one row down of the merge:
        // columns 2-4, rows 2-5.
        sendClick(canvas, cellCenter([2, 2]));
        sendClick(canvas, { ...cellCenter([4, 5]), shiftKey: true });

        fireEvent.copy(window);
        await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
        expect(navigator.clipboard.writeText).toBeCalledWith(
            ["2, 2\t\t4, 2", "\t\t4, 3", "\t\t4, 4", "2, 5\t3, 5\t4, 5"].join("\n")
        );
    });

    test("pasting over a merge writes the anchor and skips covered cells", async () => {
        const editSpy = vi.fn();
        vi.useFakeTimers();
        render(
            <EventedDataEditor
                {...(basicProps as DataEditorProps)}
                mergedRanges={MERGES}
                onPaste={true}
                onCellsEdited={editSpy}
            />,
            { wrapper: Context }
        );
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");
        vi.spyOn(document, "activeElement", "get").mockImplementation(() => canvas);

        // Paste a 3x2 block at [2,2]: it lands on the merge (cols 2-3, rows
        // 2-4), so only the anchor [2,2] inside the merge is written.
        sendClick(canvas, cellCenter([2, 2]));
        fireEvent.paste(window);
        await vi.waitFor(() => expect(editSpy).toHaveBeenCalled());

        const edited = (editSpy.mock.calls[0][0] as { location: Item }[]).map(i => i.location);
        expect(edited).toEqual([[2, 2]]);
    });

    test("deleting a selection spanning a merge clears the anchor and skips covered cells", async () => {
        const editSpy = vi.fn();
        vi.useFakeTimers();
        render(
            <EventedDataEditor
                {...(basicProps as DataEditorProps)}
                mergedRanges={MERGES}
                onCellsEdited={editSpy}
            />,
            { wrapper: Context }
        );
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        // Select the merge (cols 2-3, rows 2-4) plus one extra column and row:
        // cols 2-4, rows 2-5. Delete must clear the anchor and the cells
        // outside the merge, never the five covered members.
        sendClick(canvas, cellCenter([2, 2]));
        sendClick(canvas, { ...cellCenter([4, 5]), shiftKey: true });
        fireEvent.keyDown(canvas, { key: "Delete" });
        await vi.waitFor(() => expect(editSpy).toHaveBeenCalled());

        const edited = (editSpy.mock.calls[0][0] as { location: Item }[]).map(i => i.location);
        expect(edited).toEqual(
            expect.arrayContaining([
                [2, 2],
                [4, 2],
                [4, 3],
                [4, 4],
                [2, 5],
                [3, 5],
                [4, 5],
            ])
        );
        expect(edited).toHaveLength(7);
    });

    test("accessibility tree renders one spanning td per merge", () => {
        vi.useFakeTimers();
        render(<DataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} />, {
            wrapper: Context,
        });
        prep(false);

        const anchor = document.getElementById("glide-cell-2-2");
        expect(anchor).not.toBeNull();
        expect(anchor?.getAttribute("rowspan")).toBe("3");
        expect(anchor?.getAttribute("colspan")).toBe("2");
        // Covered cells are not rendered.
        expect(document.getElementById("glide-cell-3-2")).toBeNull();
        expect(document.getElementById("glide-cell-2-3")).toBeNull();
        expect(document.getElementById("glide-cell-3-4")).toBeNull();
        // Neighbors are untouched.
        expect(document.getElementById("glide-cell-1-2")).not.toBeNull();
        expect(document.getElementById("glide-cell-4-2")).not.toBeNull();
        expect(document.getElementById("glide-cell-2-5")).not.toBeNull();
        expect(document.getElementById("glide-cell-1-2")?.hasAttribute("rowspan")).toBe(false);
    });

    test("a11y selection marks the whole merge selected", () => {
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} />, {
            wrapper: Context,
        });
        prep(false);
        const canvas = screen.getByTestId("data-grid-canvas");

        sendClick(canvas, cellCenter([3, 3]));
        act(() => {
            vi.runAllTimers();
        });
        vi.useRealTimers();

        const anchor = document.getElementById("glide-cell-2-2");
        expect(anchor?.getAttribute("aria-selected")).toBe("true");
        expect(document.getElementById("glide-cell-1-2")?.getAttribute("aria-selected")).toBe("false");
    });
});
