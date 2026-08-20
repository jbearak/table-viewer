import type { HostMessage } from '../types';

type CompareDiffMsg = Extract<HostMessage, { type: 'compareDiff' }>;

export type CompareRowStatus = 'added' | 'deleted';

/**
 * Store for git-compare diff pages. Pure (no React): `on_change` is injected so
 * the ingest/eviction logic is unit-testable with a spy, mirroring RowLoader.
 * The host posts a `compareDiff` page alongside every `rowData` window it
 * serves, so this needs no request machinery of its own — it only ingests.
 *
 * Rows in a page are display rows (`startRow + i`), matching the rowData window
 * the diff was computed for; columns are canonical source columns, the same
 * space `get_cell_content` resolves before painting.
 */
export class CompareLoader {
    /** Non-'same' row statuses, keyed by absolute display row. */
    private readonly status_by_row = new Map<number, CompareRowStatus>();
    /** Pre-change cell text, keyed by `row:col` (display row, source column). */
    private readonly base_by_cell = new Map<string, string>();
    /** Ingested pages (LRU) so eviction can retract exactly what a page added. */
    private readonly pages = new Map<number, { rows: number[]; cells: string[] }>();
    private _generation = 1;
    private sheet_index = 0;

    constructor(
        private readonly on_change: () => void,
        private readonly max_pages = 64,
    ) {}

    /** Point at a sheet + generation; clears stored pages when either changes. */
    configure(sheet_index: number, generation: number): void {
        if (sheet_index === this.sheet_index && generation === this._generation) return;
        this.sheet_index = sheet_index;
        this._generation = generation;
        this.clear();
    }

    /** Ingest a host `compareDiff` page. Returns false (and ignores) when stale. */
    on_compare_diff(msg: CompareDiffMsg): boolean {
        if (msg.generation !== this._generation) return false;
        if (msg.sheetIndex !== this.sheet_index) return false;
        if (!Array.isArray(msg.rowStatus) || !Array.isArray(msg.changedCells)) return false;
        const previous = this.pages.get(msg.startRow);
        if (previous !== undefined) this.retract(previous);
        this.pages.delete(msg.startRow); // re-insert to mark most-recently-used
        const rows: number[] = [];
        const cells: string[] = [];
        for (let i = 0; i < msg.rowStatus.length; i++) {
            const status = msg.rowStatus[i];
            if (status !== 'added' && status !== 'deleted') continue;
            const row = msg.startRow + i;
            rows.push(row);
            this.status_by_row.set(row, status);
        }
        for (const cell of msg.changedCells) {
            const key = `${cell.row}:${cell.col}`;
            cells.push(key);
            this.base_by_cell.set(key, cell.base);
        }
        this.pages.set(msg.startRow, { rows, cells });
        this.evict();
        this.on_change();
        return true;
    }

    /** 'added' / 'deleted' band for a display row; undefined = unchanged/unknown. */
    get_status(row: number): CompareRowStatus | undefined {
        return this.status_by_row.get(row);
    }

    /** The original-side text of a changed cell; undefined = unchanged/unknown. */
    get_base(row: number, col: number): string | undefined {
        return this.base_by_cell.get(`${row}:${col}`);
    }

    /** For tests: number of resident pages. */
    get page_count(): number {
        return this.pages.size;
    }

    clear(): void {
        this.status_by_row.clear();
        this.base_by_cell.clear();
        this.pages.clear();
    }

    private retract(page: { rows: number[]; cells: string[] }): void {
        for (const row of page.rows) this.status_by_row.delete(row);
        for (const key of page.cells) this.base_by_cell.delete(key);
    }

    private evict(): void {
        while (this.pages.size > this.max_pages) {
            const [start, page] = this.pages.entries().next().value!;
            this.pages.delete(start);
            this.retract(page);
        }
    }
}
