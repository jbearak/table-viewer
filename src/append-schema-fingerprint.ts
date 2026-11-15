import { createHash } from 'crypto';
import type { SheetMeta } from './data-source/interface';

/**
 * The schema half of an append basis: a worksheet's column count and column
 * names. A Header Row change changes the names without changing the columns,
 * so the header commit re-stamps a pending `appendBasis` with this (see
 * `plan_excel_override_state`); the append, insert, replay, and save checks in
 * viewer-controller.ts compare against it.
 */
export function worksheet_append_schema_fingerprint(
    sheet: Pick<SheetMeta, 'columnCount' | 'columnNames'>,
): string {
    return `sha256:${createHash('sha256').update(JSON.stringify({
        columnCount: sheet.columnCount,
        columnNames: sheet.columnNames ?? null,
    })).digest('hex')}`;
}
