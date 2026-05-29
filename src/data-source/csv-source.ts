// src/data-source/csv-source.ts
import Papa from 'papaparse';
import type { DataSource, RenderedCell, RowWindow, WorkbookMeta } from './interface';
import { build_line_index, type LineIndex } from './line-index';

/**
 * DataSource backed by a UTF-8 CSV/TSV byte buffer.
 *
 * Construction cost: one O(n) byte scan (build_line_index) that yields both the
 * row offsets and each row's field count, so the sheet's shape (row and column
 * counts) is known without ever decoding the whole buffer or materialising every
 * parsed row. This matters at scale: the old "decode all + PapaParse all" shape
 * pass transiently held the entire file as a JS string plus a string[][] of every
 * cell (~1 GB RSS at 1M rows). Thereafter, read_rows pays only for the requested
 * window (a byte subarray slice + PapaParse of that fragment).
 *
 * NOTE on byte vs. char offsets: line-index offsets are UTF-8 byte positions.
 * read_rows therefore slices `this.buf` (Uint8Array) using those byte offsets and
 * decodes the fragment with TextDecoder — not via String.prototype.slice, which
 * uses UTF-16 char indices. The two coincide for pure ASCII but diverge for any
 * multibyte characters (e.g. 'é' is 1 UTF-16 char but 2 UTF-8 bytes). The byte-
 * slice approach is correct for all encodings.
 */
export class CsvDataSource implements DataSource {
    readonly truncationMessage?: string;
    /** Per-row field counts before padding, capped to kept rows (save path). */
    readonly originalColumnCounts: number[];
    /** Detected line terminator so re-serialization round-trips (save path). */
    readonly lineEnding: '\r\n' | '\r' | '\n';
    private readonly index: LineIndex;
    private readonly _rowCount: number;
    private readonly _colCount: number;

    /**
     * Async factory mirroring XlsxDataSource.create, so panel-core can build any
     * format via one `await Source.create(...)` without branching on construction
     * style. CSV parsing is synchronous; this just wraps the constructor.
     */
    static async create(
        buf: Uint8Array,
        delimiter: ',' | '\t',
        max_rows: number,
    ): Promise<CsvDataSource> {
        return new CsvDataSource(buf, delimiter, max_rows);
    }

    constructor(
        private readonly buf: Uint8Array,
        private readonly delimiter: ',' | '\t',
        max_rows: number,
    ) {
        // Pass the delimiter byte so the indexer's field-start quote detection
        // matches PapaParse (a `"` only opens a quoted field at a field start).
        // The index also yields per-row field counts, so the shape below is read
        // straight off the byte scan — no whole-buffer decode or full parse. A
        // trailing newline produces no extra empty row (build_line_index skips the
        // end-of-buffer boundary), matching parse-csv's trailing-empty-row rule.
        this.index = build_line_index(buf, delimiter.charCodeAt(0));

        const total = this.index.rowCount;
        let kept = total;
        if (total > max_rows) {
            kept = max_rows;
            this.truncationMessage =
                `Showing ${max_rows.toLocaleString()} of ${total.toLocaleString()} rows`;
        }
        this._rowCount = kept;
        let colCount = 0;
        const originalColumnCounts: number[] = new Array(kept);
        for (let i = 0; i < kept; i++) {
            const len = this.index.fieldCountOf(i);
            originalColumnCounts[i] = len;
            if (len > colCount) colCount = len;
        }
        this._colCount = colCount;
        this.originalColumnCounts = originalColumnCounts;
        this.lineEnding = detect_line_ending(buf);
    }

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this._rowCount,
                columnCount: this._colCount,
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet: number, start_row: number, count: number): RowWindow {
        const start = Math.max(0, Math.min(start_row, this._rowCount));
        const end = Math.min(start + count, this._rowCount);
        if (start >= end) return { startRow: start, rows: [] };

        const byteStart = this.index.offsetOf(start);
        const byteEnd = this.index.endOffsetOf(end - 1);

        // Slice the Uint8Array by byte offsets, then decode — correct for multibyte
        // characters. (String.prototype.slice uses UTF-16 char indices, which
        // diverge from UTF-8 byte offsets whenever multibyte chars are present.)
        const fragment_bytes = this.buf.subarray(byteStart, byteEnd);
        const fragment = new TextDecoder('utf-8').decode(fragment_bytes);

        const parsed = Papa.parse(fragment, {
            delimiter: this.delimiter, header: false, skipEmptyLines: false,
        }).data as string[][];

        const rows: (RenderedCell | null)[][] = [];
        for (let i = 0; i < end - start; i++) {
            rows.push(this.to_cells(parsed[i] ?? []));
        }
        return { startRow: start, rows };
    }

    read_all_rows(_sheet: number): (RenderedCell | null)[][] {
        return this.read_rows(0, 0, this._rowCount).rows;
    }

    close(): void { /* nothing to release */ }

    private to_cells(row: string[]): (RenderedCell | null)[] {
        const cells: (RenderedCell | null)[] = [];
        for (let c = 0; c < this._colCount; c++) {
            const v = c < row.length ? row[c] : '';
            cells.push(v === '' ? null : { raw: v, formatted: v, bold: false, italic: false });
        }
        return cells;
    }
}

const LF = 0x0a; // \n
const CR = 0x0d; // \r

/** First line terminator wins; defaults to '\n' for single-line sources.
 *  Mirrors parse-csv.ts so CSV save round-trips the original ending. Scans the
 *  raw bytes (stopping at the first terminator) so we never decode the whole
 *  buffer just to learn its line ending. */
function detect_line_ending(buf: Uint8Array): '\r\n' | '\r' | '\n' {
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === CR) {
            return (i + 1 < buf.length && buf[i + 1] === LF) ? '\r\n' : '\r';
        }
        if (buf[i] === LF) return '\n';
    }
    return '\n';
}
