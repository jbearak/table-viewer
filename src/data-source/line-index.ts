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
    // Per-row field counts in an Int32Array (4 bytes/row, ~4 MB per 1M rows). A
    // single CSV row can declare arbitrarily many fields (the CSV path has no
    // column cap), but a 32-bit signed int holds far more than any real row, so
    // this is safe while keeping the per-row overhead small.
    const counts = Int32Array.from(field_counts);
    return {
        rowCount: arr.length,
        offsetOf: (r) => arr[r],
        endOffsetOf: (r) => (r + 1 < arr.length ? arr[r + 1] : buf.length),
        fieldCountOf: (r) => counts[r],
    };
}

/**
 * Map each grid row to the 0-based source text line where it begins — the data
 * the CSV preview pane needs for scroll synchronization. Row r's value is the
 * number of physical line terminators (LF, CR, or CRLF — CRLF counted once) that
 * appear before row r's start byte, which equals the editor line that row sits
 * on. Embedded newlines inside a quoted field advance the line counter (the
 * editor still renders them as separate lines) but not the row, so a multi-line
 * quoted field correctly leaves a gap in the returned values.
 *
 * Derived from the SAME row boundaries as build_line_index (passed in as
 * `index`), so the result is always exactly `min(rowCount, index.rowCount)` long
 * and can never disagree with the grid's row count. Line counting here needs no
 * quote awareness: the editor treats every physical newline as a line break, and
 * the index already tells us where each row starts.
 *
 * `first_row` is the absolute index row that grid row 0 maps to: 0 normally, or 1
 * when the CSV source consumed row 0 as the header (so the preview still scrolls
 * to the correct source line for each data row). The returned map is indexed by
 * grid row; its values are absolute source line numbers (the header line is just
 * skipped over by the line counter, leaving the data rows correctly numbered).
 */
export function build_line_map(
    buf: Uint8Array,
    index: LineIndex,
    rowCount: number = index.rowCount,
    first_row: number = 0,
): number[] {
    const n = Math.min(rowCount, Math.max(0, index.rowCount - first_row));
    const line_map = new Array<number>(n);
    let line = 0;
    let r = 0; // grid row; the absolute index row is r + first_row
    for (let i = 0; i < buf.length && r < n; i++) {
        // Record the line for every row that starts at byte i (offsets are
        // strictly increasing, so at most one row matches per byte).
        while (r < n && index.offsetOf(r + first_row) === i) {
            line_map[r] = line;
            r++;
        }
        const b = buf[i];
        if (b === LF) {
            line++;
        } else if (b === CR) {
            if (i + 1 < buf.length && buf[i + 1] === LF) i++; // CRLF counts once
            line++;
        }
    }
    // Defensive: any rows whose start offset is at/after buffer end (not emitted
    // by build_line_index) take the final line count.
    while (r < n) { line_map[r] = line; r++; }
    return line_map;
}

/**
 * Parse a decoded CSV/TSV text fragment into rows of string fields, using the
 * EXACT model as build_line_index above. This is the single source of truth for
 * cell values: because the byte scanner (which yields row offsets and per-row
 * field counts) and this string parser apply identical quote/field/terminator
 * rules, the shape derived from the index can never disagree with the cells
 * produced here. That invariant is what keeps the save path lossless — serialize
 * reads `originalColumnCounts` (from the index) and the cell values (from here),
 * and the two always describe the same grid.
 *
 * Rules (mirroring build_line_index):
 *  - A row boundary is an unquoted CR, LF, or CRLF (CRLF consumed as one); a
 *    terminator at end-of-text does NOT create a trailing empty row.
 *  - Fields split on an unquoted `delimiter`.
 *  - A `"` opens a quoted field only at a field start (text start, post-
 *    delimiter, or post-boundary). Inside quotes, `""` is a literal `"` and a
 *    lone `"` closes the field. A `"` anywhere else is a literal data char.
 *
 * The caller must pass text decoded WITHOUT BOM stripping mid-fragment (i.e. a
 * TextDecoder with `ignoreBOM: true`, or a buffer whose leading BOM was already
 * removed) so the string indices line up byte-for-byte with the index scan.
 */
export function split_csv_rows(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    const fields: string[] = [];
    let field = '';
    let in_quotes = false;
    // True when the next char begins a fresh field — only then can a `"` open a
    // quoted field. Matches build_line_index's `field_start` gate.
    let field_start = true;
    // True once any char belonging to the current row has been seen. Governs the
    // final-row flush: a terminator at end-of-text leaves this false, so we emit
    // no phantom empty row (matching build_line_index's end-of-buffer rule).
    let row_dirty = false;
    const n = text.length;

    const end_row = () => {
        fields.push(field);
        rows.push(fields.slice());
        fields.length = 0;
        field = '';
        field_start = true;
        row_dirty = false;
    };

    for (let i = 0; i < n; i++) {
        const ch = text[i];
        if (in_quotes) {
            if (ch === '"') {
                if (i + 1 < n && text[i + 1] === '"') {
                    field += '"'; // escaped quote ("") -> one literal "
                    i++;
                    continue;
                }
                in_quotes = false; // closing quote
                continue;
            }
            field += ch;
            continue;
        }
        if (ch === '"' && field_start) {
            in_quotes = true;
            field_start = false;
            row_dirty = true;
            continue;
        }
        if (ch === delimiter) {
            fields.push(field);
            field = '';
            field_start = true;
            row_dirty = true;
            continue;
        }
        if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && i + 1 < n && text[i + 1] === '\n') i++; // CRLF
            end_row();
            continue;
        }
        field += ch; // literal char (incl. a stray quote in an unquoted field)
        field_start = false;
        row_dirty = true;
    }
    // Flush the final row only if it carried content (no trailing terminator).
    if (row_dirty) {
        fields.push(field);
        rows.push(fields.slice());
    }
    return rows;
}
