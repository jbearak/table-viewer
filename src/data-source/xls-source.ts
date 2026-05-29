// NOTE: parse_xls_streaming is synchronous (returns its result directly, not a
// Promise), so XlsDataSource can be constructed synchronously via
// `new XlsDataSource(buf)`.
//
// Memory note for 1M-row goal (Task A7 — resolved): cells flow from the parse
// working-set directly into each sheet's ColumnarStore via parse_xls_streaming's
// `fill` seam (the same shared seam the .xlsx source uses). The legacy densified
// (CellData|null)[][] is never materialized, so the parse working-set and the
// columnar store no longer co-exist as two full representations of the same
// sheet — the transient 2× peak is gone.

import { parse_xls_streaming } from '../parse-xls';
import { ColumnarStore } from './columnar-store';
import type { DataSource, RowWindow, WorkbookMeta } from './interface';
import type { MergeRange } from '../types';

interface SheetEntry {
    name: string;
    rowCount: number;
    columnCount: number;
    merges: MergeRange[];
    hasFormatting: boolean;
    store: ColumnarStore;
}

export class XlsDataSource implements DataSource {
    private readonly sheets: SheetEntry[];
    private readonly _hasFormatting: boolean;
    readonly warnings: string[];

    /**
     * Async factory mirroring XlsxDataSource.create, so panel-core can build any
     * format via one `await Source.create(...)` without branching on construction
     * style. parse_xls is synchronous; this just wraps the constructor.
     */
    static async create(buf: Buffer): Promise<XlsDataSource> {
        return new XlsDataSource(buf);
    }

    constructor(buf: Buffer) {
        const parsed = parse_xls_streaming(buf);
        const has_formatting = parsed.hasFormatting;
        this.warnings = parsed.warnings;
        this._hasFormatting = has_formatting;
        this.sheets = parsed.sheets.map((s) => {
            // Fill the columnar store directly from the parse working-set; no
            // intermediate (CellData|null)[][] is ever allocated. The fill seam
            // applies the same null/blank + raw-normalization rules this loop
            // used to apply inline.
            const b = new ColumnarStore.Builder(s.rowCount, s.columnCount);
            s.fill(b);
            return {
                name: s.name,
                rowCount: s.rowCount,
                columnCount: s.columnCount,
                merges: s.merges,
                // workbook-level flag; parse_xls exposes no per-sheet formatting granularity
                hasFormatting: has_formatting,
                store: b.build(),
            };
        });
    }

    meta(): WorkbookMeta {
        return {
            hasFormatting: this._hasFormatting,
            sheets: this.sheets.map((s) => ({
                name: s.name,
                rowCount: s.rowCount,
                columnCount: s.columnCount,
                merges: s.merges,
                hasFormatting: s.hasFormatting,
            })),
        };
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        if (sheet_index < 0 || sheet_index >= this.sheets.length) {
            throw new RangeError(`sheet index ${sheet_index} out of range (${this.sheets.length} sheets)`);
        }
        const s = this.sheets[sheet_index];
        // Clamp to the same bounds ColumnarStore.read_window applies internally so
        // the reported startRow always matches the offset the returned rows begin
        // at (an out-of-range start_row would otherwise desync the two).
        const clamped = Math.max(0, Math.min(start_row, s.store.rowCount));
        return { startRow: clamped, rows: s.store.read_window(clamped, count) };
    }

    close(): void { /* GC */ }
}
