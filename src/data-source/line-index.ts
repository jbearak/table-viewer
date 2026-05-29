// src/data-source/line-index.ts

const QUOTE = 0x22;  // "
const LF = 0x0a;     // \n
const CR = 0x0d;     // \r
const COMMA = 0x2c;  // ,

export interface LineIndex {
    rowCount: number;
    /** Byte offset where row r begins. */
    offsetOf(r: number): number;
    /** Byte offset where row r ends (start of next row, or buffer end). */
    endOffsetOf(r: number): number;
    /**
     * Number of fields in row r (unquoted delimiters + 1) — i.e. the column
     * count PapaParse would report for that row. Computed in the same scan as
     * the offsets so the CSV source never has to materialise every parsed row
     * just to learn the sheet's shape.
     */
    fieldCountOf(r: number): number;
}

/**
 * Single O(n) pass over UTF-8 bytes. A row boundary is an unquoted CR, LF, or
 * CRLF; newlines inside a quoted field do not split a row. Returns byte offsets,
 * so a caller can slice + parse any contiguous row range.
 *
 * Quote handling mirrors PapaParse (RFC 4180): a `"` only opens a quoted field
 * when it is the first byte of a field — at buffer start, or immediately after a
 * row boundary or the field delimiter. A `"` anywhere else is a literal data
 * byte. Inside a quoted field, a doubled `""` is an escaped literal quote (both
 * bytes consumed, still quoted); a lone `"` closes the field. This keeps row
 * boundaries aligned with how `read_rows` re-parses each sliced fragment, so
 * stray quotes in unquoted fields can't merge or split rows differently.
 *
 * `delimiter` is the field-separator byte (',' for CSV, 0x09 tab for TSV); it
 * must match the delimiter passed to PapaParse for the boundary detection to be
 * correct on quoted fields that follow a delimiter.
 */
export function build_line_index(buf: Uint8Array, delimiter: number = COMMA): LineIndex {
    const offsets: number[] = [];
    if (buf.length > 0) offsets.push(0);
    // Field count for each row (unquoted delimiters + 1), pushed when a row ends.
    // Stays length-aligned with `offsets`: each row contributes one offset (at its
    // start) and one field count (at its end), so both arrays equal rowCount.
    const field_counts: number[] = [];
    let fields = 1;

    let in_quotes = false;
    // True when the next byte begins a fresh field (buffer start, post-delimiter,
    // or post-row-boundary) — only then can a `"` open a quoted field.
    let field_start = true;
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (in_quotes) {
            if (b === QUOTE) {
                if (i + 1 < buf.length && buf[i + 1] === QUOTE) {
                    i++; // escaped quote ("") — consume both, stay quoted
                    continue;
                }
                in_quotes = false; // closing quote
            }
            continue;
        }
        if (b === QUOTE && field_start) {
            in_quotes = true;
            field_start = false;
            continue;
        }
        if (b === delimiter) {
            fields++;
            field_start = true;
            continue;
        }
        if (b === LF || b === CR) {
            let next = i + 1;
            if (b === CR && next < buf.length && buf[next] === LF) next++;
            // The row that just ended contributes its field count here; the next
            // row (if any) resets the running tally to a single field.
            field_counts.push(fields);
            fields = 1;
            // A boundary at end-of-buffer does not start a new (empty) row.
            if (next < buf.length) offsets.push(next);
            i = next - 1;
            field_start = true;
            continue;
        }
        field_start = false;
    }
    // No trailing newline: the final row never hit a boundary, so flush its count.
    if (field_counts.length < offsets.length) field_counts.push(fields);

    // Use a typed array for memory; Float64Array (8 bytes/row) -> ~8 MB per 1M rows.
    // Float64Array is required because byte offsets can exceed the signed 32-bit max (~2 GB).
    const arr = Float64Array.from(offsets);
    // Field counts are bounded by the column cap (256), so Int32Array (4 bytes/row)
    // is ample and keeps the per-row overhead small (~4 MB per 1M rows).
    const counts = Int32Array.from(field_counts);
    return {
        rowCount: arr.length,
        offsetOf: (r) => arr[r],
        endOffsetOf: (r) => (r + 1 < arr.length ? arr[r + 1] : buf.length),
        fieldCountOf: (r) => counts[r],
    };
}
