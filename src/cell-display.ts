import type { RawCell } from './data-source/interface';
import type { CellData } from './types';

export function get_raw_cell_text(raw: CellData['raw']): string {
    return raw !== null ? String(raw) : '';
}

export function get_cell_comparison_text(
    cell: RawCell | null | undefined,
): string {
    const comparison_key = cell?.comparisonKey;
    return comparison_key === undefined
        ? `raw:${get_raw_cell_text(cell?.raw ?? null)}`
        : `comparison:${comparison_key}`;
}
