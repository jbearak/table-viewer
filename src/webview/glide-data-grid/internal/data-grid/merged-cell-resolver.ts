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
// allocating string keys. The per-covered-cell Map trades construction cost
// and memory (proportional to total merged area) for allocation-free O(1)
// lookups in the hottest loop; real spreadsheet merges keep that area small.
// The Rectangle stored for a merge is a single stable object, so callers may
// use it as an identity key.
import { packColRowToNumber } from "../../common/render-state-provider.js";
import type { Rectangle } from "./data-grid-types.js";
import type { CellSet } from "./cell-set.js";

export class MergedCellResolver {
    private readonly cellToRange: Map<number, Rectangle>;

    constructor(ranges: readonly Rectangle[], colOffset: number = 0, colCount: number = Infinity, rowCount: number = Infinity) {
        const map = new Map<number, Rectangle>();
        for (const raw of ranges) {
            // Degenerate (empty or single-cell), negative, and out-of-grid
            // ranges are silently dropped: a 1x1 "merge" is just a cell,
            // negative coordinates can never be walked, and a range past the
            // grid edge would index columns that do not exist.
            if (raw.width < 1 || raw.height < 1 || raw.width * raw.height <= 1) continue;
            if (raw.x < 0 || raw.y < 0) continue;
            const range: Rectangle =
                colOffset === 0 ? raw : { x: raw.x + colOffset, y: raw.y, width: raw.width, height: raw.height };
            if (range.x + range.width > colCount || range.y + range.height > rowCount) continue;

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
        }
        this.cellToRange = map;
    }

    public get isEmpty(): boolean {
        return this.cellToRange.size === 0;
    }

    /** The merge containing (col, row) — anchor or covered — or undefined. */
    public getRange(col: number, row: number): Rectangle | undefined {
        return this.cellToRange.get(packColRowToNumber(col, row));
    }

    /**
     * Expands a damage set so that damaging any cell of a merge damages the
     * whole merge (the anchor's content paints across all covered cells).
     * Returns the input set unchanged (same identity) when no damaged cell
     * touches a merge.
     */
    public expandDamage(locations: CellSet): CellSet {
        if (this.cellToRange.size === 0) return locations;
        let expanded: CellSet | undefined;
        let expandedRanges: Set<Rectangle> | undefined;
        for (const item of locations.values()) {
            const range = this.cellToRange.get(packColRowToNumber(item[0], item[1]));
            if (range === undefined) continue;
            // The stored Rectangle is one object per merge, so identity
            // dedups members of an already-expanded merge.
            if (expandedRanges?.has(range) === true) continue;
            expanded ??= locations.clone();
            expandedRanges ??= new Set();
            expandedRanges.add(range);
            for (let r = range.y; r < range.y + range.height; r++) {
                for (let c = range.x; c < range.x + range.width; c++) {
                    expanded.add([c, r]);
                }
            }
        }
        return expanded ?? locations;
    }
}
