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
import type { Item, Rectangle } from "./data-grid-types.js";
import type { CellSet } from "./cell-set.js";

export class MergedCellResolver {
    private readonly cellToRange: Map<number, Rectangle>;
    // Accepted ranges, kept for range-level scans (expandRange); per-cell
    // lookups always go through the map.
    private readonly acceptedRanges: readonly Rectangle[];

    constructor(ranges: readonly Rectangle[], colOffset: number = 0, colCount: number = Infinity, rowCount: number = Infinity) {
        const accepted: Rectangle[] = [];
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
            accepted.push(range);
        }
        this.cellToRange = map;
        this.acceptedRanges = accepted;
    }

    public get isEmpty(): boolean {
        return this.cellToRange.size === 0;
    }

    /** The merge containing (col, row) — anchor or covered — or undefined. */
    public getRange(col: number, row: number): Rectangle | undefined {
        return this.cellToRange.get(packColRowToNumber(col, row));
    }

    /** The anchor for (col, row); the cell itself when unmerged. */
    public anchorOf(col: number, row: number): Item {
        const range = this.cellToRange.get(packColRowToNumber(col, row));
        return range === undefined ? [col, row] : [range.x, range.y];
    }

    /**
     * Grows a rectangle until it fully contains every merge it touches
     * (fixpoint — growing over one merge can reach another). Returns the
     * input rectangle (same identity) when nothing grows. Mirrors the app's
     * expand_range_for_merges oracle.
     */
    public expandRange(range: Rectangle): Rectangle {
        if (this.acceptedRanges.length === 0) return range;
        let x = range.x;
        let y = range.y;
        let right = range.x + range.width;
        let bottom = range.y + range.height;
        let changed = true;
        while (changed) {
            changed = false;
            for (const m of this.acceptedRanges) {
                if (m.x < right && m.x + m.width > x && m.y < bottom && m.y + m.height > y) {
                    if (m.x < x) {
                        x = m.x;
                        changed = true;
                    }
                    if (m.y < y) {
                        y = m.y;
                        changed = true;
                    }
                    if (m.x + m.width > right) {
                        right = m.x + m.width;
                        changed = true;
                    }
                    if (m.y + m.height > bottom) {
                        bottom = m.y + m.height;
                        changed = true;
                    }
                }
            }
        }
        if (x === range.x && y === range.y && right === range.x + range.width && bottom === range.y + range.height) {
            return range;
        }
        return { x, y, width: right - x, height: bottom - y };
    }

    /**
     * A merge spanning both sides of the horizontal grid line above `line`
     * (rows line-1 and line) within columns [left, right), or undefined.
     * Selection edges must not sit on such a line.
     */
    public mergeCrossingRowLine(line: number, left: number, right: number): Rectangle | undefined {
        for (const m of this.acceptedRanges) {
            if (m.y < line && m.y + m.height > line && m.x < right && m.x + m.width > left) return m;
        }
        return undefined;
    }

    /**
     * A merge spanning both sides of the vertical grid line left of `line`
     * (columns line-1 and line) within rows [top, bottom), or undefined.
     */
    public mergeCrossingColLine(line: number, top: number, bottom: number): Rectangle | undefined {
        for (const m of this.acceptedRanges) {
            if (m.x < line && m.x + m.width > line && m.y < bottom && m.y + m.height > top) return m;
        }
        return undefined;
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
