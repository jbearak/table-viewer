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
    line_ending: '\r\n' | '\r' | '\n' = '\n',
    header_line?: string,
): string {
    const lines: string[] = [];

    // Precompute per-row max edited column so the inner loop is O(1), and the
    // highest edited row so edits that land past the source's last row (e.g. a
    // stale edit left over after the file shrank on an external reload) are
    // still written instead of being silently dropped on save.
    let max_edit_col: Map<number, number> | undefined;
    let max_edit_row = -1;
    if (edits) {
        max_edit_col = new Map();
        for (const key of Object.keys(edits)) {
            const [er, ec] = key.split(':').map(Number);
            const cur = max_edit_col.get(er);
            if (cur === undefined || ec > cur) max_edit_col.set(er, ec);
            if (er > max_edit_row) max_edit_row = er;
        }
    }

    const serialize_row = (r: number, row: (CellData | null)[]): string => {
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
        return fields.join(delimiter);
    };

    let r = 0;
    for (const row of rows) {
        lines.push(serialize_row(r, row));
        r++;
    }

    // Append any edits keyed beyond the last source row, filling the gap with
    // empty rows. serialize_row reads only `edits` for these (the source row is
    // empty), so a gap row with no edit collapses to a blank line.
    for (; r <= max_edit_row; r++) {
        lines.push(serialize_row(r, []));
    }

    // A logically empty sheet serializes to empty output, not a lone terminator.
    const body = lines.length === 0 ? '' : lines.join(line_ending) + line_ending;
    // When the source consumed row 0 as the column header, the grid's data rows
    // exclude it; re-prepend it verbatim so the saved file keeps its header. A
    // header-only file (empty body) still re-emits the lone header line.
    return header_line === undefined ? body : header_line + line_ending + body;
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
