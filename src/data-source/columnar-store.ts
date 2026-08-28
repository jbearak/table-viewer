import type { CellHyperlink, RichText } from '../cell-content';
import type { RenderedCell } from './interface';

const NULL_IDX = -1;
const BOLD = 1, ITALIC = 2, UNDERLINE = 4, STRIKETHROUGH = 8, HAS_EXTRAS = 16;
const FORMULA_RESULT_PENDING = 32, DATE_1904 = 64, XLSX_ISO_DATE = 128;
const TYPE_STRING = 1, TYPE_NUMBER = 2, TYPE_BOOLEAN = 3, TYPE_EMPTY = 4, TYPE_DATE = 5,
    TYPE_ERROR = 6;

/** Sparse per-cell metadata that only exceptional cells carry. Immutable
 *  objects supplied by the parser are stored by reference and shared with
 *  every materialized RenderedCell. */
interface CellExtras {
    richText?: RichText;
    hyperlink?: CellHyperlink;
    formula?: string;
}

export class ColumnarStore {
    private constructor(
        private readonly rows: number,
        private readonly cols: number,
        private readonly pool: string[],
        private readonly rawIdx: Int32Array,
        private readonly fmtIdx: Int32Array,
        private readonly numberFormatIdx: Int32Array | undefined,
        /** Lazily allocated for display-text cells with an underlying scalar. */
        private readonly numericRaw: Float64Array | undefined,
        private readonly flags: Uint8Array,
        private readonly types: Uint8Array,
        /** Keyed by linear cell index (row * cols + col). */
        private readonly extras: ReadonlyMap<number, CellExtras>,
    ) {}

    get poolSize(): number { return this.pool.length; }
    get rowCount(): number { return this.rows; }
    get colCount(): number { return this.cols; }

    read_window(start_row: number, count: number): (RenderedCell | null)[][] {
        const start = Math.max(0, Math.min(start_row, this.rows));
        const end = Math.min(start + count, this.rows);
        const out: (RenderedCell | null)[][] = [];
        for (let r = start; r < end; r++) {
            const row: (RenderedCell | null)[] = [];
            for (let c = 0; c < this.cols; c++) {
                row.push(this.read_cell(r, c));
            }
            out.push(row);
        }
        return out;
    }

    /** Materialize full rows by absolute index without visiting intervening rows. */
    read_rows_indexed(row_indices: ArrayLike<number>): (RenderedCell | null)[][] {
        for (let position = 0; position < row_indices.length; position++) {
            const row = row_indices[position];
            if (!Number.isInteger(row) || row < 0 || row >= this.rows) {
                throw new RangeError(`row index ${row} out of range (${this.rows} rows)`);
            }
        }
        return Array.from(row_indices, (row) => {
            const cells: (RenderedCell | null)[] = [];
            for (let column = 0; column < this.cols; column++) {
                cells.push(this.read_cell(row, column));
            }
            return cells;
        });
    }

    /** Materialize a compact projection without visiting unrelated cells. */
    read_columns(
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): (RenderedCell | null)[][] {
        for (const column of column_indices) {
            if (!Number.isInteger(column) || column < 0 || column >= this.cols) {
                throw new RangeError(`column index ${column} out of range (${this.cols} columns)`);
            }
        }
        const start = Math.max(0, Math.min(start_row, this.rows));
        const end = Math.min(start + count, this.rows);
        const out: (RenderedCell | null)[][] = [];
        for (let r = start; r < end; r++) {
            const row: (RenderedCell | null)[] = [];
            for (const c of column_indices) {
                row.push(this.read_cell(r, c));
            }
            out.push(row);
        }
        return out;
    }

    private read_cell(row: number, column: number): RenderedCell | null {
        const index = row * this.cols + column;
        if (this.rawIdx[index] === NULL_IDX) return null;
        const flags = this.flags[index];
        const cell: RenderedCell = {
            raw: this.pool[this.rawIdx[index]],
            formatted: this.pool[this.fmtIdx[index]],
            bold: (flags & BOLD) !== 0,
            italic: (flags & ITALIC) !== 0,
            rawType: decode_type(this.types[index]),
        };
        if ((flags & UNDERLINE) !== 0) cell.underline = true;
        if ((flags & STRIKETHROUGH) !== 0) cell.strikethrough = true;
        const format_index = this.numberFormatIdx?.[index] ?? NULL_IDX;
        if (format_index !== NULL_IDX) {
            cell.numberFormat = {
                code: this.pool[format_index],
                ...((flags & DATE_1904) !== 0 ? { date1904: true as const } : {}),
            };
        }
        if ((flags & XLSX_ISO_DATE) !== 0) cell.xlsxIsoDate = true;
        if ((flags & FORMULA_RESULT_PENDING) !== 0) cell.formulaResultPending = true;
        const numeric_raw = this.numericRaw?.[index] ?? Number.NaN;
        if (!Number.isNaN(numeric_raw)) cell.numericRaw = numeric_raw;
        // The HAS_EXTRAS bit keeps plain-cell reads off the map entirely, so
        // one linked cell doesn't turn every read into a hash probe.
        if ((flags & HAS_EXTRAS) !== 0) {
            const extras = this.extras.get(index);
            if (extras?.richText) cell.richText = extras.richText;
            if (extras?.hyperlink) cell.hyperlink = extras.hyperlink;
            if (extras?.formula) cell.formula = extras.formula;
        }
        return cell;
    }

    static Builder = class {
        private readonly pool: string[] = [''];           // index 0 = ""
        private readonly poolMap = new Map<string, number>([['', 0]]);
        private readonly rawIdx: Int32Array;
        private readonly fmtIdx: Int32Array;
        private numberFormatIdx: Int32Array | undefined;
        private numericRaw: Float64Array | undefined;
        private readonly flags: Uint8Array;
        private readonly types: Uint8Array;
        private readonly extras = new Map<number, CellExtras>();

        constructor(private readonly rows: number, private readonly cols: number) {
            const n = rows * cols;
            this.rawIdx = new Int32Array(n).fill(NULL_IDX);
            this.fmtIdx = new Int32Array(n).fill(NULL_IDX);
            this.flags = new Uint8Array(n);
            this.types = new Uint8Array(n);
        }

        private intern(s: string): number {
            let idx = this.poolMap.get(s);
            if (idx === undefined) { idx = this.pool.length; this.pool.push(s); this.poolMap.set(s, idx); }
            return idx;
        }

        set(r: number, c: number, cell: RenderedCell | null): void {
            const i = r * this.cols + c;
            if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) {
                throw new RangeError(`cell (${r},${c}) out of bounds for ${this.rows}x${this.cols} store`);
            }
            // Overwrites are rare (fills write each index once), so only pay
            // the sparse cleanup when this index actually held optional data.
            if ((this.flags[i] & HAS_EXTRAS) !== 0) this.extras.delete(i);
            if (this.numberFormatIdx) this.numberFormatIdx[i] = NULL_IDX;
            if (this.numericRaw) this.numericRaw[i] = Number.NaN;
            if (cell === null) {
                this.rawIdx[i] = NULL_IDX;
                this.fmtIdx[i] = NULL_IDX;
                this.flags[i] = 0;
                return;
            }
            // raw === null normalised to '' — consistent with interface's null = empty cell semantics
            this.rawIdx[i] = this.intern(cell.raw ?? '');
            this.fmtIdx[i] = this.intern(cell.formatted);
            let flags = (cell.bold ? BOLD : 0)
                | (cell.italic ? ITALIC : 0)
                | (cell.underline ? UNDERLINE : 0)
                | (cell.strikethrough ? STRIKETHROUGH : 0);
            if (cell.numberFormat) {
                if (!this.numberFormatIdx) {
                    this.numberFormatIdx = new Int32Array(this.rawIdx.length).fill(NULL_IDX);
                }
                this.numberFormatIdx[i] = this.intern(cell.numberFormat.code);
                if (cell.numberFormat.date1904) flags |= DATE_1904;
            }
            if (cell.xlsxIsoDate) flags |= XLSX_ISO_DATE;
            if (cell.formulaResultPending) flags |= FORMULA_RESULT_PENDING;
            if (cell.numericRaw !== undefined) {
                if (!Number.isFinite(cell.numericRaw)) {
                    throw new Error('numericRaw must be finite');
                }
                if (!this.numericRaw) {
                    this.numericRaw = new Float64Array(this.rawIdx.length).fill(Number.NaN);
                }
                this.numericRaw[i] = cell.numericRaw;
            }
            this.types[i] = encode_type(cell.rawType);
            if (cell.richText || cell.hyperlink || cell.formula) {
                // Stored by reference: the parser hands over immutable objects
                // (shared across cells that reuse one rich shared string).
                const extras: CellExtras = {};
                if (cell.richText) extras.richText = cell.richText;
                if (cell.hyperlink) extras.hyperlink = cell.hyperlink;
                if (cell.formula) extras.formula = cell.formula;
                this.extras.set(i, extras);
                flags |= HAS_EXTRAS;
            }
            this.flags[i] = flags;
        }

        build(): ColumnarStore {
            return new ColumnarStore(
                this.rows, this.cols, this.pool,
                this.rawIdx, this.fmtIdx, this.numberFormatIdx, this.numericRaw,
                this.flags, this.types, this.extras,
            );
        }
    };
}

function encode_type(type: RenderedCell['rawType']): number {
    switch (type) {
        case 'string': return TYPE_STRING;
        case 'number': return TYPE_NUMBER;
        case 'boolean': return TYPE_BOOLEAN;
        case 'date': return TYPE_DATE;
        case 'error': return TYPE_ERROR;
        case 'empty': return TYPE_EMPTY;
        default: return 0;
    }
}

function decode_type(type: number): RenderedCell['rawType'] {
    switch (type) {
        case TYPE_STRING: return 'string';
        case TYPE_NUMBER: return 'number';
        case TYPE_BOOLEAN: return 'boolean';
        case TYPE_DATE: return 'date';
        case TYPE_ERROR: return 'error';
        case TYPE_EMPTY: return 'empty';
        default: return undefined;
    }
}
