// src/data-source/csv-source.ts
import type { DataSource, RenderedCell, RowWindow, WorkbookMeta } from './interface';
import { build_line_index, build_line_map, split_csv_rows, type LineIndex } from './line-index';

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
    /** Verbatim header line (terminator stripped) when row 0 was consumed as the
     *  column names; undefined otherwise. The save path re-prepends it. */
    readonly headerLine?: string;
    private readonly index: LineIndex;
    private readonly _rowCount: number;
    private readonly _colCount: number;
    /** Absolute index row that grid row 0 maps to: 1 when the first row was
     *  consumed as the header, else 0. */
    private readonly _dataStart: number;
    /** Buffer with any leading UTF-8 BOM removed (see constructor). */
    private readonly buf: Uint8Array;
    /** Reused across read_rows: decode() is stateless for non-streaming calls,
     *  so one decoder serves every page request (this is a per-scroll hot path). */
    private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    /** Structurally immutable after construction; built once (see constructor). */
    private readonly _meta: WorkbookMeta;
    /** Lazily-built row -> source-line map (preview scroll sync only). */
    private _lineMap?: number[];

    /**
     * Async factory mirroring XlsxDataSource.create, so panel-core can build any
     * format via one `await Source.create(...)` without branching on construction
     * style. CSV parsing is synchronous; this just wraps the constructor.
     */
    static async create(
        buf: Uint8Array,
        delimiter: ',' | '\t',
        max_rows: number,
        opts?: { firstRowIsHeader?: boolean },
    ): Promise<CsvDataSource> {
        return new CsvDataSource(buf, delimiter, max_rows, opts);
    }

    constructor(
        buf: Uint8Array,
        private readonly delimiter: ',' | '\t',
        max_rows: number,
        opts?: { firstRowIsHeader?: boolean },
    ) {
        // Strip a leading UTF-8 BOM (EF BB BF) up front so the byte scan and the
        // decoded fragments in read_rows operate on identical content. Otherwise
        // the index would see the BOM as 3 literal bytes before the first field
        // (so a following `"` would NOT be treated as a field start), while the
        // string parser — fed BOM-free text — would open a quoted field. Removing
        // it once here keeps both views aligned and drops the BOM from saves.
        this.buf = (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
            ? buf.subarray(3)
            : buf;
        // Pass the delimiter byte so the indexer's field-start quote detection
        // matches the cell parser (a `"` only opens a quoted field at a field
        // start). The index also yields per-row field counts, so the shape below
        // is read straight off the byte scan — no whole-buffer decode or full
        // parse. A trailing newline produces no extra empty row (build_line_index
        // skips the end-of-buffer boundary), matching the cell parser's rule.
        this.index = build_line_index(this.buf, delimiter.charCodeAt(0));

        // When the first row is the header, grid row 0 is the second physical row
        // (_dataStart = 1) and the header's cells become the column names. An empty
        // buffer has no header row, so there is nothing to consume.
        const total = this.index.rowCount;
        const header = (opts?.firstRowIsHeader ?? false) && total > 0;
        this._dataStart = header ? 1 : 0;

        const dataTotal = total - this._dataStart;
        let kept = dataTotal;
        if (dataTotal > max_rows) {
            kept = max_rows;
            this.truncationMessage =
                `Showing ${max_rows.toLocaleString()} of ${dataTotal.toLocaleString()} rows`;
        }
        this._rowCount = kept;

        // colCount spans the header row (when present) and the kept data rows, so a
        // header wider than every data row still shows all of its columns.
        let colCount = header ? this.index.fieldCountOf(0) : 0;
        const originalColumnCounts: number[] = new Array(kept);
        for (let i = 0; i < kept; i++) {
            const len = this.index.fieldCountOf(i + this._dataStart);
            originalColumnCounts[i] = len;
            if (len > colCount) colCount = len;
        }
        this._colCount = colCount;
        this.originalColumnCounts = originalColumnCounts;
        this.lineEnding = detect_line_ending(this.buf, delimiter.charCodeAt(0));

        let columnNames: string[] | undefined;
        if (header) {
            // The row-0 byte slice runs up to the next row's start, so it carries
            // the line terminator; trim those bytes off so headerLine is the
            // verbatim header text (quoting preserved) the save path re-prepends.
            const start = this.index.offsetOf(0);
            let end = this.index.endOffsetOf(0);
            while (end > start && (this.buf[end - 1] === LF || this.buf[end - 1] === CR)) end--;
            this.headerLine = this.decoder.decode(this.buf.subarray(start, end));
            const fields = split_csv_rows(this.headerLine, delimiter)[0] ?? [];
            columnNames = new Array(colCount);
            for (let c = 0; c < colCount; c++) columnNames[c] = c < fields.length ? fields[c] : '';
        }

        this._meta = {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this._rowCount,
                columnCount: this._colCount,
                merges: [],
                hasFormatting: false,
                columnNames,
            }],
        };
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    read_rows(_sheet: number, start_row: number, count: number): RowWindow {
        const start = Math.max(0, Math.min(start_row, this._rowCount));
        const end = Math.min(start + count, this._rowCount);
        if (start >= end) return { startRow: start, rows: [] };

        // Grid rows are offset past the consumed header row (_dataStart) when in
        // header mode, so a grid row maps to index row (grid row + _dataStart).
        const byteStart = this.index.offsetOf(start + this._dataStart);
        const byteEnd = this.index.endOffsetOf(end - 1 + this._dataStart);

        // Slice the Uint8Array by byte offsets, then decode — correct for multibyte
        // characters. (String.prototype.slice uses UTF-16 char indices, which
        // diverge from UTF-8 byte offsets whenever multibyte chars are present.)
        // ignoreBOM:true so the decoder never strips a leading U+FEFF: the real
        // BOM was already removed at construction, and we need the string indices
        // to line up byte-for-byte with the index scan that produced the offsets.
        const fragment_bytes = this.buf.subarray(byteStart, byteEnd);
        const fragment = this.decoder.decode(fragment_bytes);

        // Use the shared row parser so the cells here always match the per-row
        // field counts the index derived from the same model — no save-path drift.
        const parsed = split_csv_rows(fragment, this.delimiter);

        const rows: (RenderedCell | null)[][] = [];
        for (let i = 0; i < end - start; i++) {
            rows.push(this.to_cells(parsed[i] ?? []));
        }
        return { startRow: start, rows };
    }

    /**
     * Row -> 0-based source-line map for the CSV preview pane's scroll sync.
     * Built from the same row boundaries as the grid (so its length always equals
     * the grid's rowCount) and cached, since the preview reads it on every reload.
     */
    lineMap(): number[] {
        if (!this._lineMap) {
            this._lineMap = build_line_map(this.buf, this.index, this._rowCount, this._dataStart);
        }
        return this._lineMap;
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
const QUOTE = 0x22; // "

/** First *unquoted* line terminator wins; defaults to '\n' for single-line
 *  sources. Mirrors build_line_index's quote rule so a newline embedded in a
 *  quoted field (which is not a row boundary) can't be mistaken for the file's
 *  terminator and silently rewrite every ending on save. Scans the raw bytes
 *  (stopping at the first real terminator) so we never decode the whole buffer
 *  just to learn its line ending. */
function detect_line_ending(buf: Uint8Array, delimiter: number): '\r\n' | '\r' | '\n' {
    let in_quotes = false;
    // A `"` only opens a quoted field at a field start (buffer start, post-
    // delimiter, or post-boundary). The loop returns at the first boundary, so
    // field_start only needs maintaining across delimiters within the first row.
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
            field_start = true;
            continue;
        }
        if (b === CR) {
            return (i + 1 < buf.length && buf[i + 1] === LF) ? '\r\n' : '\r';
        }
        if (b === LF) return '\n';
        field_start = false;
    }
    return '\n';
}
