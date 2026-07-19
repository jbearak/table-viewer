import { ColumnarStore } from '../../data-source/columnar-store';
import type { CellData } from '../../types';

/**
 * Build a sheet's ColumnarStore the OLD way: from a densified (CellData|null)[][]
 * (as produced by parse_xlsx / parse_xls), copying each cell exactly as the
 * data-source `create` used to. This is the byte-for-byte baseline the streaming
 * fill path must reproduce; it does NOT route through the streaming code, so the
 * parity assertions that compare against it are non-tautological.
 */
export function build_store_old_way(
    rows: (CellData | null)[][],
    rowCount: number,
    colCount: number,
): ColumnarStore {
    const b = new ColumnarStore.Builder(rowCount, colCount);
    for (let r = 0; r < rowCount; r++) {
        const row = rows[r] ?? [];
        for (let c = 0; c < colCount; c++) {
            const cell = row[c] ?? null;
            b.set(r, c, cell === null ? null : {
                raw: cell.raw === null ? '' : String(cell.raw),
                formatted: cell.formatted,
                bold: cell.bold,
                italic: cell.italic,
                rawType: cell.raw === null
                    ? 'empty'
                    : cell.rawType === 'date'
                        ? 'date'
                    : typeof cell.raw === 'number'
                        ? 'number'
                        : typeof cell.raw === 'boolean'
                            ? 'boolean'
                            : 'string',
            });
        }
    }
    return b.build();
}
