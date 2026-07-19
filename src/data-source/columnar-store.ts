import type { RenderedCell } from './interface';

const NULL_IDX = -1;
const BOLD = 1, ITALIC = 2;
const TYPE_STRING = 1, TYPE_NUMBER = 2, TYPE_BOOLEAN = 3, TYPE_EMPTY = 4, TYPE_DATE = 5;

export class ColumnarStore {
    private constructor(
        private readonly rows: number,
        private readonly cols: number,
        private readonly pool: string[],
        private readonly rawIdx: Int32Array,
        private readonly fmtIdx: Int32Array,
        private readonly flags: Uint8Array,
        private readonly types: Uint8Array,
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
                const i = r * this.cols + c;
                if (this.rawIdx[i] === NULL_IDX) { row.push(null); continue; }
                const f = this.flags[i];
                row.push({
                    raw: this.pool[this.rawIdx[i]],
                    formatted: this.pool[this.fmtIdx[i]],
                    bold: (f & BOLD) !== 0,
                    italic: (f & ITALIC) !== 0,
                    rawType: decode_type(this.types[i]),
                });
            }
            out.push(row);
        }
        return out;
    }

    static Builder = class {
        private readonly pool: string[] = [''];           // index 0 = ""
        private readonly poolMap = new Map<string, number>([['', 0]]);
        private readonly rawIdx: Int32Array;
        private readonly fmtIdx: Int32Array;
        private readonly flags: Uint8Array;
        private readonly types: Uint8Array;

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
            if (cell === null) { this.rawIdx[i] = NULL_IDX; this.fmtIdx[i] = NULL_IDX; return; }
            // raw === null normalised to '' — consistent with interface's null = empty cell semantics
            this.rawIdx[i] = this.intern(cell.raw ?? '');
            this.fmtIdx[i] = this.intern(cell.formatted);
            this.flags[i] = (cell.bold ? BOLD : 0) | (cell.italic ? ITALIC : 0);
            this.types[i] = encode_type(cell.rawType);
        }

        build(): ColumnarStore {
            return new ColumnarStore(this.rows, this.cols, this.pool, this.rawIdx, this.fmtIdx, this.flags, this.types);
        }
    };
}

function encode_type(type: RenderedCell['rawType']): number {
    switch (type) {
        case 'string': return TYPE_STRING;
        case 'number': return TYPE_NUMBER;
        case 'boolean': return TYPE_BOOLEAN;
        case 'date': return TYPE_DATE;
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
        case TYPE_EMPTY: return 'empty';
        default: return undefined;
    }
}
