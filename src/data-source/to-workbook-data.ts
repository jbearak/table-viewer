import type { DataSource } from './interface';
import type { WorkbookData, SheetData, CellData } from '../types';

/**
 * Transitional shim (Phases B–D): rebuild the legacy single-blob WorkbookData
 * shape from a DataSource so the existing DOM `<table>` renderer keeps working
 * while the Glide webview is built. Reads each sheet's full row range up front
 * — the same cost the old parsers paid — and is deleted in Phase E once the
 * webview consumes the paginated protocol exclusively.
 */
export function workbook_data_from_source(source: DataSource): WorkbookData {
    const meta = source.meta();
    const sheets: SheetData[] = meta.sheets.map((s, i) => {
        const window = source.read_rows(i, 0, s.rowCount);
        const rows: (CellData | null)[][] = window.rows.map((row) =>
            row.map((cell) =>
                cell === null
                    ? null
                    : {
                          raw: cell.raw,
                          formatted: cell.formatted,
                          bold: cell.bold,
                          italic: cell.italic,
                      }
            )
        );
        return {
            name: s.name,
            rows,
            merges: s.merges,
            columnCount: s.columnCount,
            rowCount: s.rowCount,
        };
    });
    return { hasFormatting: meta.hasFormatting, sheets };
}
