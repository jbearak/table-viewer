import type { MergeRange } from '../types';

/** A merge range with precomputed spans and a hint for the renderer. */
export interface MergeEntry {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    /** endRow - startRow + 1 */
    rowSpan: number;
    /** endCol - startCol + 1 */
    colSpan: number;
    /**
     * True when the merge spans only columns (rowSpan === 1, colSpan > 1).
     * These render exactly via Glide's native `GridCell.span`; merges with
     * rowSpan > 1 need the overlay canvas (see Spike D0 in the plan).
     */
    horizontalOnly: boolean;
}

const key = (row: number, col: number): string => `${row}:${col}`;

/**
 * Fast lookups over a sheet's merge ranges, used by the cell renderer (anchor
 * vs covered classification, native-span decision) and the merge overlay
 * (enumerating rowSpan > 1 blocks). Pure and synchronous.
 *
 * Anchors and covered cells are materialized into maps for O(1) per-cell
 * lookups — the hot path is `getCellContent`, called once per visible cell on
 * every draw. The materialized size is the sum of merge areas, which is bounded
 * by the per-sheet merge-count cap and typically tiny (spreadsheet merges are
 * small).
 */
export class MergeIndex {
    readonly entries: MergeEntry[];
    private readonly anchors = new Map<string, MergeEntry>();
    private readonly cellToEntry = new Map<string, MergeEntry>();

    constructor(merges: MergeRange[]) {
        this.entries = merges.map((m) => {
            const rowSpan = m.endRow - m.startRow + 1;
            const colSpan = m.endCol - m.startCol + 1;
            return {
                startRow: m.startRow,
                startCol: m.startCol,
                endRow: m.endRow,
                endCol: m.endCol,
                rowSpan,
                colSpan,
                horizontalOnly: rowSpan === 1 && colSpan > 1,
            };
        });

        for (const e of this.entries) {
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
        return this.anchors.get(key(row, col)) ?? null;
    }

    /** The merge containing (row, col) — anchor or interior — or null. */
    entry_at(row: number, col: number): MergeEntry | null {
        return this.cellToEntry.get(key(row, col)) ?? null;
    }

    /** True when (row, col) is inside a merge but is not its anchor. */
    is_covered(row: number, col: number): boolean {
        const e = this.cellToEntry.get(key(row, col));
        return e !== undefined && !(e.startRow === row && e.startCol === col);
    }

    /** The anchor coordinates for (row, col); the cell itself when unmerged. */
    anchor_of(row: number, col: number): { row: number; col: number } {
        const e = this.cellToEntry.get(key(row, col));
        return e ? { row: e.startRow, col: e.startCol } : { row, col };
    }
}
