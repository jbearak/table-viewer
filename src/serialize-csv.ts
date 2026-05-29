import type { CellData } from './types';

/**
 * Serialize rows to CSV/TSV text.
 *
 * `rows` is an `Iterable` of rows rather than a materialized 2-D array so the
 * CSV save path can stream windows from the data source (one window's cell
 * objects become GC-eligible after it is serialized) without ever holding the
 * whole sheet in memory. Arrays are themselves iterable, so callers that pass a
 * full `(CellData | null)[][]` keep working unchanged. The absolute row index is
 * tracked manually as we iterate, since `edits` and `original_column_counts` are
 * both keyed/indexed by absolute row number.
 */
export function serialize_csv(
    rows: Iterable<(CellData | null)[]>,
    delimiter: ',' | '\t',
    edits?: Record<string, string>,
    original_column_counts?: number[],
    line_ending: '\r\n' | '\r' | '\n' = '\n'
): string {
    const lines: string[] = [];

    // Precompute per-row max edited column so the inner loop is O(1)
    let max_edit_col: Map<number, number> | undefined;
    if (edits) {
        max_edit_col = new Map();
        for (const key of Object.keys(edits)) {
            const [er, ec] = key.split(':').map(Number);
            const cur = max_edit_col.get(er);
            if (cur === undefined || ec > cur) max_edit_col.set(er, ec);
        }
    }

    let r = 0;
    for (const row of rows) {
        const fields: string[] = [];
        let col_count = original_column_counts?.[r] ?? row.length;
        // Extend if any edit targets a column beyond original count
        const max_ec = max_edit_col?.get(r);
        if (max_ec !== undefined && max_ec >= col_count) {
            col_count = max_ec + 1;
        }
        for (let c = 0; c < col_count; c++) {
            const key = `${r}:${c}`;
            let value: string;
            if (edits && key in edits) {
                value = edits[key];
            } else {
                const cell = row[c];
                value = cell !== null && cell !== undefined ? String(cell.raw ?? '') : '';
            }
            fields.push(quote_field(value, delimiter));
        }
        lines.push(fields.join(delimiter));
        r++;
    }

    return lines.join(line_ending) + line_ending;
}

function quote_field(value: string, delimiter: string): string {
    if (
        value.includes(delimiter) ||
        value.includes('\n') ||
        value.includes('\r') ||
        value.includes('"')
    ) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
