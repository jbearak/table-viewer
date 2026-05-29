// src/data-source/csv-source.ts
import Papa from 'papaparse';
import type { DataSource, RenderedCell, RowWindow, WorkbookMeta } from './interface';
import { build_line_index, type LineIndex } from './line-index';

/**
 * DataSource backed by a UTF-8 CSV/TSV byte buffer.
 *
 * Construction cost: one O(n) PapaParse pass to determine shape (row and column
 * counts), plus one O(n) byte scan to build the line index. Thereafter, read_rows
 * pays only for the requested window (a byte subarray slice + PapaParse of that
 * fragment).
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
        this.index = build_line_index(buf);

        // One full pass for shape only (row lengths), reusing parse-csv's
        // trailing-empty-row rule. We decode the whole buffer once here for
        // the shape scan; thereafter read_rows decodes only the requested fragment.
        const full_source = new TextDecoder('utf-8').decode(buf);
        const parsed = Papa.parse(full_source, { delimiter, header: false, skipEmptyLines: false });
        let rows_data = parsed.data as string[][];

        const ends_nl = full_source.length > 0 &&
            (full_source[full_source.length - 1] === '\n' ||
             full_source[full_source.length - 1] === '\r');
        const last = rows_data[rows_data.length - 1];
        if (ends_nl && last && last.length === 1 && last[0] === '') {
            rows_data = rows_data.slice(0, -1);
        }

        const total = rows_data.length;
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
            const len = rows_data[i].length;
            originalColumnCounts[i] = len;
            if (len > colCount) colCount = len;
        }
        this._colCount = colCount;
        this.originalColumnCounts = originalColumnCounts;
        this.lineEnding = detect_line_ending(full_source);
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

/** First line terminator wins; defaults to '\n' for single-line sources.
 *  Mirrors parse-csv.ts so CSV save round-trips the original ending. */
function detect_line_ending(source: string): '\r\n' | '\r' | '\n' {
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\r') {
            return (i + 1 < source.length && source[i + 1] === '\n') ? '\r\n' : '\r';
        }
        if (source[i] === '\n') return '\n';
    }
    return '\n';
}
