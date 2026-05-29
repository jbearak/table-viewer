// NOTE: parse_xlsx is async (returns a Promise), so XlsxDataSource cannot be
// constructed synchronously. Use the static async factory `XlsxDataSource.create(buf)`
// instead of `new XlsxDataSource(buf)`.
//
// Memory note for 1M-row goal: This implementation builds the legacy (CellData|null)[][]
// first, then the columnar copy — transient 2× peak. For true 1M-row xlsx, follow up
// (Phase A optimization task, only if needed) by adding a `parse_xlsx_into(builder)` seam
// in `src/parse-xlsx.ts` that writes cells directly to the builder, eliminating the
// intermediate array. Tracked as Task A7.

import { parse_xlsx } from '../parse-xlsx';
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
    private readonly _hasFormatting: boolean;
    readonly warnings: string[];

    private constructor(sheets: SheetEntry[], hasFormatting: boolean, warnings: string[]) {
        this.sheets = sheets;
        this._hasFormatting = hasFormatting;
        this.warnings = warnings;
    }

    static async create(buf: Uint8Array): Promise<XlsxDataSource> {
        const parsed = await parse_xlsx(buf);
        const has_formatting = parsed.data.hasFormatting;
        const sheets: SheetEntry[] = parsed.data.sheets.map((s) => {
            const b = new ColumnarStore.Builder(s.rowCount, s.columnCount);
            for (let r = 0; r < s.rowCount; r++) {
                const row = s.rows[r] ?? [];
                for (let c = 0; c < s.columnCount; c++) {
                    const cell = row[c] ?? null;
                    b.set(r, c, cell === null ? null : {
                        raw: cell.raw === null ? '' : String(cell.raw),
                        formatted: cell.formatted,
                        bold: cell.bold,
                        italic: cell.italic,
                    });
                }
            }
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

    read_all_rows(_sheet_index: number): never {
        throw new Error('read_all_rows is unsupported for xlsx (read-only)');
    }

    close(): void { /* GC */ }
}
