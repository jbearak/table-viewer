import type { CellData } from './types';

/** A renderer-owned record or the custom document's sparse edit projection. */
export type CsvEditValues = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

function is_edit_map(edits: CsvEditValues): edits is ReadonlyMap<string, string> {
    return typeof (edits as ReadonlyMap<string, string>).get === 'function';
}

function edit_entries(edits: CsvEditValues): Iterable<[string, string]> {
    return is_edit_map(edits) ? edits.entries() : Object.entries(edits);
}

function edit_value(edits: CsvEditValues, key: string): string | undefined {
    return is_edit_map(edits)
        ? edits.get(key)
        : Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : undefined;
}

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
 *
 * An edit keyed past the last source row is **dropped**, not appended. Under
 * source-keyed edit identity a stale edit at row 90,000 in a file that shrank to
 * 10 rows would have padded ~89,990 blank lines out to it — and because
 * `build_line_index` counts a field per LF, those blank lines re-parse as rows, so
 * a 10-row CSV would reopen as a 90,001-row table. Nothing in `src/` uses
 * `WorkspaceEdit`/`applyEdit`, so `write_file` is a raw filesystem write with
 * nothing on VS Code's undo stack: that outcome is unrecoverable. Saves carrying
 * such an edit are rejected before serialization instead — see
 * `validate_dirty_bases` (csv-base-validation.ts), whose `removedRows` outcome
 * covers exactly this case — so dropping here is the safe residual behavior for a
 * caller that skipped validation, not the policy the user ever sees.
 */
export function serialize_csv_fields(
    fields: readonly string[],
    delimiter: ',' | '\t',
): string {
    return fields.map((value) => quote_field(value, delimiter)).join(delimiter);
}

export function serialize_csv(
    rows: Iterable<(CellData | null)[]>,
    delimiter: ',' | '\t',
    edits?: CsvEditValues,
    original_column_counts?: number[],
    line_ending: '\r\n' | '\r' | '\n' = '\n',
    header_line?: string,
): string {
    const lines: string[] = [];

    // Precompute per-row max edited column so the inner loop is O(1). Column
    // growth *is* a supported feature (an edit beyond a row's original field
    // count widens that row); row growth is not — see the header comment.
    let max_edit_col: Map<number, number> | undefined;
    if (edits) {
        max_edit_col = new Map();
        for (const [key] of edit_entries(edits)) {
            const [er, ec] = key.split(':').map(Number);
            const cur = max_edit_col.get(er);
            if (cur === undefined || ec > cur) max_edit_col.set(er, ec);
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
            const edited = edits ? edit_value(edits, key) : undefined;
            if (edited !== undefined) {
                value = edited;
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
