import type { MergeRange } from '../types';

/** A merge range in source coordinates (inclusive bounds). */
export interface MergeEntry {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
}

const key = (row: number, col: number): string => `${row}:${col}`;

/**
 * Fast lookups over a sheet's merge ranges. Rendering, hit-testing, and
 * selection are handled natively by the vendored grid's own resolver; this
 * index serves the application-owned paths that see merges before or without a
 * grid round-trip — guarded copy (blanking covered cells), Tab traversal and
 * editor commit navigation (skipping covered cells), and multiline auto-grow
 * (measuring a vertical merge's whole block). Pure and synchronous.
 *
 * Anchors and covered cells are materialized into maps for O(1) per-cell
 * lookups. The materialized size is the sum of merge areas, which is bounded
 * by the per-sheet merge-count cap and typically tiny (spreadsheet merges are
 * small).
 */
export class MergeIndex {
    private readonly size: number;
    private readonly anchors = new Map<string, MergeEntry>();
    private readonly cellToEntry = new Map<string, MergeEntry>();

    constructor(merges: MergeRange[]) {
        this.size = merges.length;
        for (const m of merges) {
            const e: MergeEntry = {
                startRow: m.startRow,
                startCol: m.startCol,
                endRow: m.endRow,
                endCol: m.endCol,
            };
            this.anchors.set(key(e.startRow, e.startCol), e);
            for (let r = e.startRow; r <= e.endRow; r++) {
                for (let c = e.startCol; c <= e.endCol; c++) {
                    this.cellToEntry.set(key(r, c), e);
                }
            }
        }
    }

    /** The merge anchored exactly at (row, col), or null. */
    is_anchor(row: number, col: number): MergeEntry | null {
        // Fast path for the common no-merge sheet (CSV, most xlsx): skip the
        // per-cell key-string allocation + map lookup that runs once per visible
        // cell on every draw.
        if (this.size === 0) return null;
        return this.anchors.get(key(row, col)) ?? null;
    }

    /** True when (row, col) is inside a merge but is not its anchor. */
    is_covered(row: number, col: number): boolean {
        if (this.size === 0) return false;
        const e = this.cellToEntry.get(key(row, col));
        return e !== undefined && !(e.startRow === row && e.startCol === col);
    }
}
