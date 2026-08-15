// Fork addition: Stage-3 interaction tests for mergedRanges — click
// canonicalization to the anchor, merge-aware keyboard navigation, and
// range expansion over merges.
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

// Center of a cell in canvas coordinates.
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

// DataEditor is controlled when onGridSelectionChange is provided; feed the
// selection back so consecutive events build on each other (mirrors the
// EventedDataEditor wrapper in data-editor.test.tsx).
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

function sendClick(el: Element, options: { clientX: number; clientY: number }): void {
    fireEvent.mouseDown(el, options);
    fireEvent.mouseUp(el, options);
    fireEvent.click(el, options);
}

// The merge under test: anchor [2,2], spanning columns 2-3 and rows 2-4.
const MERGES = [{ x: 2, y: 2, width: 2, height: 3 }];

function lastSelection(spy: ReturnType<typeof vi.fn>): GridSelection {
    return spy.mock.calls.at(-1)?.[0] as GridSelection;
}

describe("mergedRanges interaction", () => {
    beforeEach(() => {
        Element.prototype.scrollTo = vi.fn() as any;
        Element.prototype.scrollBy = vi.fn() as any;
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

    test("clicking a covered cell selects the anchor with the full merged range", () => {
        const spy = vi.fn();
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} onGridSelectionChange={spy} />, {
            wrapper: Context,
        });
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        sendClick(canvas, cellCenter([3, 4]));

        const sel = lastSelection(spy);
        expect(sel.current?.cell).toEqual([2, 2]);
        expect(sel.current?.range).toEqual({ x: 2, y: 2, width: 2, height: 3 });
    });

    test("arrow navigation steps past a merge instead of landing inside it", () => {
        const spy = vi.fn();
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} onGridSelectionChange={spy} />, {
            wrapper: Context,
        });
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        // Select the cell above the merge, then arrow down twice: first into
        // the merge (anchor), then past its bottom edge.
        sendClick(canvas, cellCenter([2, 1]));
        expect(lastSelection(spy).current?.cell).toEqual([2, 1]);

        fireEvent.keyDown(canvas, { key: "ArrowDown" });
        expect(lastSelection(spy).current?.cell).toEqual([2, 2]);

        fireEvent.keyDown(canvas, { key: "ArrowDown" });
        expect(lastSelection(spy).current?.cell).toEqual([2, 5]);

        fireEvent.keyDown(canvas, { key: "ArrowUp" });
        expect(lastSelection(spy).current?.cell).toEqual([2, 2]);

        fireEvent.keyDown(canvas, { key: "ArrowUp" });
        expect(lastSelection(spy).current?.cell).toEqual([2, 1]);
    });

    test("horizontal navigation steps past a merge", () => {
        const spy = vi.fn();
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} onGridSelectionChange={spy} />, {
            wrapper: Context,
        });
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        sendClick(canvas, cellCenter([1, 3]));
        expect(lastSelection(spy).current?.cell).toEqual([1, 3]);

        fireEvent.keyDown(canvas, { key: "ArrowRight" });
        expect(lastSelection(spy).current?.cell).toEqual([2, 2]);

        fireEvent.keyDown(canvas, { key: "ArrowRight" });
        expect(lastSelection(spy).current?.cell).toEqual([4, 2]);
    });

    test("shift+arrow selection grows over the whole merge", () => {
        const spy = vi.fn();
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} onGridSelectionChange={spy} />, {
            wrapper: Context,
        });
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        // Start above the merge and grow down into it: the range must
        // swallow the merge whole (columns 2-3, rows 1-4).
        sendClick(canvas, cellCenter([2, 1]));
        fireEvent.keyDown(canvas, { key: "ArrowDown", shiftKey: true });

        const sel = lastSelection(spy);
        expect(sel.current?.cell).toEqual([2, 1]);
        expect(sel.current?.range).toEqual({ x: 2, y: 1, width: 2, height: 4 });
    });

    test("drag selection over a covered cell includes the full merge", () => {
        const spy = vi.fn();
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} onGridSelectionChange={spy} />, {
            wrapper: Context,
        });
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        fireEvent.mouseDown(canvas, cellCenter([1, 1]));
        fireEvent.mouseMove(canvas, { ...cellCenter([2, 3]), buttons: 1 });
        fireEvent.mouseUp(canvas, cellCenter([2, 3]));

        const sel = lastSelection(spy);
        expect(sel.current?.range).toEqual({ x: 1, y: 1, width: 3, height: 4 });
    });

    test("double-clicking a covered cell edits the anchor", async () => {
        vi.useFakeTimers();
        render(<EventedDataEditor {...(basicProps as DataEditorProps)} mergedRanges={MERGES} />, {
            wrapper: Context,
        });
        prep();
        const canvas = screen.getByTestId("data-grid-canvas");

        // First click selects (canonicalized to the anchor), second click on
        // the now-selected covered cell opens the overlay for the anchor.
        sendClick(canvas, cellCenter([3, 4]));
        sendClick(canvas, cellCenter([3, 4]));

        const overlay = await screen.findByDisplayValue("2, 2");
        expect(document.body.contains(overlay)).toBe(true);
    });
});
