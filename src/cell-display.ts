import type { CellData } from './types';

export function get_raw_cell_text(raw: CellData['raw']): string {
    return raw !== null ? String(raw) : '';
}
