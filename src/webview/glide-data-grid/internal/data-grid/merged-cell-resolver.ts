// Fork addition (not upstream): resolves merged cell ranges for the renderer.
//
// The public `mergedRanges` prop on DataEditor is a list of rectangles in
// cell coordinates (x = column, y = row, width = column span, height = row
// span). DataEditor builds one resolver per distinct ranges value (deep-memo)
// with the row-marker column offset already applied, so everything below the
// editor — including the draw loop — works in mangled (inner) coordinates.
//
// The draw loop consults the resolver once per walked cell, so lookups use
// the same packed-number scheme as CellSet/RenderStateProvider rather than
// allocating string keys.
import { packColRowToNumber } from "../../common/render-state-provider.js";
import type { Item, Rectangle } from "./data-grid-types.js";
import { CellSet } from "./cell-set.js";

export class MergedCellResolver {
    /** Validated, offset ranges. Overlapping or degenerate input is dropped. */
    public readonly ranges: readonly Rectangle[];
    private readonly cellToRange: Map<number, Rectangle>;

    constructor(ranges: readonly Rectangle[], colOffset: number = 0) {
        const accepted: Rectangle[] = [];
        const map = new Map<number, Rectangle>();
        for (const raw of ranges) {
            // Degenerate (empty or single-cell) and out-of-bounds ranges are
            // silently dropped: a 1x1 "merge" is just a cell, and negative
            // coordinates can never be walked.
            if (raw.width < 1 || raw.height < 1 || raw.width * raw.height <= 1) continue;
            if (raw.x < 0 || raw.y < 0) continue;
            const range: Rectangle =
                colOffset === 0 ? raw : { x: raw.x + colOffset, y: raw.y, width: raw.width, height: raw.height };

            // First listed wins: a range overlapping an accepted one is dropped.
            let overlaps = false;
            for (let r = range.y; r < range.y + range.height && !overlaps; r++) {
                for (let c = range.x; c < range.x + range.width; c++) {
                    if (map.has(packColRowToNumber(c, r))) {
                        overlaps = true;
                        break;
                    }
                }
            }
            if (overlaps) continue;

            for (let r = range.y; r < range.y + range.height; r++) {
                for (let c = range.x; c < range.x + range.width; c++) {
                    map.set(packColRowToNumber(c, r), range);
                }
            }
            accepted.push(range);
        }
        this.ranges = accepted;
        this.cellToRange = map;
    }

    public get isEmpty(): boolean {
        return this.ranges.length === 0;
    }

    /** The merge containing (col, row) — anchor or covered — or undefined. */
    public getRange(col: number, row: number): Rectangle | undefined {
        if (this.ranges.length === 0) return undefined;
        return this.cellToRange.get(packColRowToNumber(col, row));
    }

    /** True when (col, row) is inside a merge but is not its anchor. */
    public isCovered(col: number, row: number): boolean {
        const range = this.getRange(col, row);
        return range !== undefined && (range.x !== col || range.y !== row);
    }

    /** The anchor for (col, row); the cell itself when unmerged. */
    public anchorOf(col: number, row: number): Item {
        const range = this.getRange(col, row);
        return range === undefined ? [col, row] : [range.x, range.y];
    }

    /**
     * Expands a damage set so that damaging any cell of a merge damages the
     * whole merge (the anchor's content paints across all covered cells).
     * Returns the input set unchanged (same identity) when no damaged cell
     * touches a merge.
     */
    public expandDamage(locations: CellSet): CellSet {
        if (this.ranges.length === 0) return locations;
        let expanded: CellSet | undefined;
        for (const item of locations.values()) {
            const range = this.cellToRange.get(packColRowToNumber(item[0], item[1]));
            if (range === undefined) continue;
            if (expanded === undefined) {
                expanded = new CellSet([...locations.values()]);
            }
            for (let r = range.y; r < range.y + range.height; r++) {
                for (let c = range.x; c < range.x + range.width; c++) {
                    expanded.add([c, r]);
                }
            }
        }
        return expanded ?? locations;
    }
}
