// NOTE: parse_xls is synchronous (returns ParseResult directly, not a Promise), so
// XlsDataSource can be constructed synchronously via `new XlsDataSource(buf)`.
//
// Memory note for 1M-row goal: This implementation builds the legacy (CellData|null)[][]
// first, then the columnar copy — transient 2× peak. For true 1M-row xls, follow up
// (Phase A optimization task, only if needed) by adding a `parse_xls_into(builder)` seam
// in `src/parse-xls.ts` that writes cells directly to the builder, eliminating the
// intermediate array. Tracked as Task A7.

import { parse_xls } from '../parse-xls';
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
        const parsed = parse_xls(buf);
        const has_formatting = parsed.data.hasFormatting;
        this.warnings = parsed.warnings;
        this._hasFormatting = has_formatting;
        this.sheets = parsed.data.sheets.map((s) => {
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
        return { startRow: Math.max(0, start_row), rows: s.store.read_window(start_row, count) };
    }

    read_all_rows(_sheet_index: number): never {
        throw new Error('read_all_rows is unsupported for xls (read-only)');
    }

    close(): void { /* GC */ }
}
