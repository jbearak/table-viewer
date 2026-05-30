// NOTE: parse_xlsx_streaming is async (returns a Promise), so XlsxDataSource cannot
// be constructed synchronously. Use the static async factory
// `XlsxDataSource.create(buf)` instead of `new XlsxDataSource(buf)`.
//
// Memory note for 1M-row goal (Task A7 — resolved): cells flow from the parse
// working-set directly into each sheet's ColumnarStore via parse_xlsx_streaming's
// `fill` seam. The legacy densified (CellData|null)[][] is never materialized, so
// the parse working-set and the columnar store no longer co-exist as two full
// representations of the same sheet — the transient 2× peak is gone.

import { parse_xlsx_streaming } from '../parse-xlsx';
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

export class XlsxDataSource implements DataSource {
    private readonly sheets: SheetEntry[];
    /** Structurally immutable after construction; built once (see constructor). */
    private readonly _meta: WorkbookMeta;
    readonly warnings: string[];

    private constructor(sheets: SheetEntry[], hasFormatting: boolean, warnings: string[]) {
        this.sheets = sheets;
        this.warnings = warnings;
        this._meta = {
            hasFormatting,
            sheets: sheets.map((s) => ({
                name: s.name,
                rowCount: s.rowCount,
                columnCount: s.columnCount,
                merges: s.merges,
                hasFormatting: s.hasFormatting,
            })),
        };
    }

    static async create(buf: Uint8Array): Promise<XlsxDataSource> {
        const parsed = await parse_xlsx_streaming(buf);
        const has_formatting = parsed.hasFormatting;
        const sheets: SheetEntry[] = parsed.sheets.map((s) => {
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
                // workbook-level flag; parse_xlsx exposes no per-sheet formatting granularity
                hasFormatting: has_formatting,
                store: b.build(),
            };
        });
        return new XlsxDataSource(sheets, has_formatting, parsed.warnings);
    }

    meta(): WorkbookMeta {
        return this._meta;
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
