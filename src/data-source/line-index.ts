// src/data-source/line-index.ts

const QUOTE = 0x22;  // "
const LF = 0x0a;     // \n
const CR = 0x0d;     // \r

export interface LineIndex {
    rowCount: number;
    /** Byte offset where row r begins. */
    offsetOf(r: number): number;
    /** Byte offset where row r ends (start of next row, or buffer end). */
    endOffsetOf(r: number): number;
}

/**
 * Single O(n) pass over UTF-8 bytes. A row boundary is an unquoted CR, LF, or
 * CRLF. Quote parity is tracked so newlines inside "..." do not split a row.
 * Returns byte offsets, so a caller can slice + parse any contiguous row range.
 */
export function build_line_index(buf: Uint8Array): LineIndex {
    const offsets: number[] = [];
    if (buf.length > 0) offsets.push(0);

    let in_quotes = false;
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === QUOTE) {
            in_quotes = !in_quotes;
            continue;
        }
        if (in_quotes) continue;
        if (b === LF || b === CR) {
            let next = i + 1;
            if (b === CR && next < buf.length && buf[next] === LF) next++;
            // A boundary at end-of-buffer does not start a new (empty) row.
            if (next < buf.length) offsets.push(next);
            i = next - 1;
        }
    }

    // Use a typed array for memory; Float64Array (8 bytes/row) -> ~8 MB per 1M rows.
    // Float64Array is required because byte offsets can exceed the signed 32-bit max (~2 GB).
    const arr = Float64Array.from(offsets);
    return {
        rowCount: arr.length,
        offsetOf: (r) => arr[r],
        endOffsetOf: (r) => (r + 1 < arr.length ? arr[r + 1] : buf.length),
    };
}
