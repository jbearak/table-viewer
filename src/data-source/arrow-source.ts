import {
    ArrowBuffer,
    is_missing_value_object,
    type ArrowCell,
    type ArrowDictionary,
    type ArrowVariable,
} from '@jbearak/dta-parser';
import { assert_safe_sheet_shape, create_workbook_budget } from '../spreadsheet-safety';
import type {
    ColumnFilterMetadata,
    ColumnWindow,
    DataSource,
    IndexedRawColumns,
    IndexedRows,
    RawCell,
    RawColumnWindow,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from './interface';
import { format_arrow_value, raw_arrow_cell } from './arrow-format';

const PAGE_ROWS = 256;
const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_PAGES = 8;
const DECODED_METADATA_BYTES = 32 * 1024 * 1024;

interface Page {
    rows: ArrowCell[][];
    bytes: number;
}

function active(is_cancelled: () => boolean): void {
    if (is_cancelled()) {
        const error = new Error('Arrow source read was cancelled.');
        error.name = 'AbortError';
        throw error;
    }
}

const yield_to_event_loop = (): Promise<void> =>
    new Promise(resolve => setImmediate(resolve));

/** Buffered Arrow IPC source. Reads and decodes selected columns through the public parser API. */
export class ArrowDataSource implements DataSource {
    private reader: ArrowBuffer | undefined;
    private readonly workbook: WorkbookMeta;
    private readonly variables: ArrowVariable[];
    private readonly labels = new Map<number, Map<string, string>>();
    private readonly dictionaries = new Map<number, ArrowDictionary>();
    private readonly pages = new Map<string, Page>();
    private cacheBytes = 0;
    private metadataBytes = 0;
    private readonly columns: number[];

    private constructor(reader: ArrowBuffer) {
        // Check shape before metadata/dictionary materialization or row allocation.
        assert_safe_sheet_shape(create_workbook_budget(), reader.nobs, reader.nvar, 0);
        this.reader = reader;
        const metadata = reader.metadata;
        this.variables = metadata.variables;
        this.columns = this.variables.map((_, index) => index);
        const tables = new Map<string, Map<string, string>>();
        for (let index = 0; index < this.variables.length; index++) {
            const name = this.variables[index].profile?.value_labels;
            if (name === undefined) {
                continue;
            }
            let table = tables.get(name);
            if (!table) {
                const entries = metadata.dataset?.value_labels[name];
                if (!entries) {
                    continue;
                }
                let bytes = 64;
                for (const entry of entries) {
                    const key = entry.tag ?? String(entry.value);
                    bytes += 64 + (key.length + entry.label.length) * 2;
                }
                this.admit_metadata(bytes);
                table = new Map(entries.map(entry => [
                    entry.tag ?? String(entry.value), entry.label,
                ]));
                tables.set(name, table);
            }
            this.labels.set(index, table);
        }
        this.workbook = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: reader.nobs,
                sourceRowCount: reader.nobs,
                columnCount: reader.nvar,
                merges: [],
                hasFormatting: true,
                columnNames: this.variables.map(variable => variable.name),
            }],
        };
    }

    static async create(bytes: Uint8Array): Promise<ArrowDataSource> {
        return new ArrowDataSource(ArrowBuffer.open(bytes));
    }

    private open(): ArrowBuffer {
        if (!this.reader) {
            throw new Error('Arrow source is closed');
        }
        return this.reader;
    }

    meta(): WorkbookMeta {
        this.open();
        return structuredClone(this.workbook);
    }

    private range(sheet: number, start: number, count: number): {
        start: number;
        count: number;
    } {
        const reader = this.open();
        if (sheet !== 0) {
            throw new RangeError(`sheet index ${sheet} out of range (1 sheet)`);
        }
        if (
            !Number.isSafeInteger(start) || !Number.isSafeInteger(count)
            || start < 0 || count < 0
        ) {
            throw new RangeError('Invalid Arrow row range');
        }
        start = Math.min(start, reader.nobs);
        return { start, count: Math.min(count, reader.nobs - start) };
    }

    private validate_columns(columns: readonly number[]): void {
        const reader = this.open();
        for (const column of columns) {
            if (!Number.isInteger(column) || column < 0 || column >= reader.nvar) {
                throw new RangeError(`column index ${column} out of range`);
            }
        }
    }

    private admit_metadata(bytes: number): void {
        if (bytes + this.metadataBytes > DECODED_METADATA_BYTES) {
            throw new Error('Arrow dictionary/value-label metadata exceeds the 32 MiB decoded budget');
        }
        this.metadataBytes += bytes;
    }

    private dictionary(column: number): ArrowDictionary | undefined {
        const reader = this.open();
        if (this.variables[column].type !== 'dictionary') {
            return undefined;
        }
        let result = this.dictionaries.get(column);
        if (!result) {
            result = reader.get_dictionary(column)!;
            // The public reader materializes this array before its size is known.
            // Bound retained levels separately from row pages; this is not a
            // process peak-memory bound or a bound on the parser's own buffers.
            let bytes = 64 + result.levels.length * 32;
            for (const level of result.levels) {
                if (level !== null) {
                    bytes += 48 + level.length * 2;
                }
                if (bytes + this.metadataBytes > DECODED_METADATA_BYTES) {
                    break;
                }
            }
            this.admit_metadata(bytes);
            this.dictionaries.set(column, result);
        }
        return result;
    }

    private page(start: number, columns: readonly number[]): ArrowCell[][] {
        const reader = this.open();
        const key = `${start}:${columns.join(',')}`;
        const found = this.pages.get(key);
        if (found) {
            this.pages.delete(key);
            this.pages.set(key, found);
            return found.rows;
        }
        const count = Math.min(PAGE_ROWS, reader.nobs - start);
        const rows: ArrowCell[][] = Array.from(
            { length: count },
            () => new Array<ArrowCell>(columns.length),
        );
        // Coalesce adjacent selected columns. Sparse projections never decode gaps.
        for (let position = 0; position < columns.length;) {
            const first = position;
            while (position + 1 < columns.length && columns[position + 1] === columns[position] + 1) {
                position++;
            }
            const end = position + 1;
            const decoded = reader.read_rows(start, count, columns[first], columns[position] + 1);
            for (let row = 0; row < count; row++) {
                for (let col = first; col < end; col++) {
                    rows[row][col] = decoded[row][col - first];
                }
            }
            position = end;
        }
        let bytes = rows.length * 32;
        for (const row of rows) {
            for (const cell of row) {
                bytes += 32 + (typeof cell === 'string' ? cell.length * 2 : 0);
            }
        }
        if (bytes <= CACHE_BYTES) {
            while (
                this.pages.size
                && (this.pages.size >= CACHE_PAGES || this.cacheBytes + bytes > CACHE_BYTES)
            ) {
                const oldest = this.pages.keys().next().value!;
                this.cacheBytes -= this.pages.get(oldest)!.bytes;
                this.pages.delete(oldest);
            }
            this.pages.set(key, { rows, bytes });
            this.cacheBytes += bytes;
        }
        return rows;
    }

    private cell(value: ArrowCell, column: number, render: boolean): RawCell | RenderedCell {
        const dictionary = value === null ? undefined : this.dictionary(column);
        const level = dictionary ? dictionary.levels[Number(value)] : undefined;
        const raw = raw_arrow_cell(value, level);
        const variable = this.variables[column];
        if (
            (typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value)))
            && (variable.type === 'date32' || variable.type === 'timestamp'
                || variable.type === 'duration' || variable.temporal_semantics)
        ) {
            raw.comparisonKey = `arrow:temporal:${JSON.stringify([
                variable.type,
                variable.unit,
                variable.epoch,
                variable.timezone,
                variable.temporal_semantics,
                raw.raw,
            ])}`;
        }
        if (!render) {
            return raw;
        }
        const label = this.labels.get(column)?.get(
            is_missing_value_object(value) ? value.missing_type : String(value),
        );
        return {
            ...raw,
            formatted: label ?? (dictionary
                ? level ?? 'null'
                : format_arrow_value(value, this.variables[column], raw.raw)),
            bold: false,
            italic: false,
        };
    }

    private read(
        sheet: number,
        start: number,
        count: number,
        columns: readonly number[],
        render: boolean,
    ): {
        startRow: number;
        rows: (RawCell | RenderedCell)[][];
    } {
        const range = this.range(sheet, start, count);
        this.validate_columns(columns);
        const selected = [...new Set(columns)].sort((a, b) => a - b);
        const positions = new Map(selected.map((column, index) => [column, index]));
        const rows: (RawCell | RenderedCell)[][] = [];
        for (let offset = 0; offset < range.count;) {
            const absolute = range.start + offset;
            const pageStart = Math.floor(absolute / PAGE_ROWS) * PAGE_ROWS;
            const page = this.page(pageStart, selected);
            const first = absolute - pageStart;
            const length = Math.min(page.length - first, range.count - offset);
            for (let row = first; row < first + length; row++) {
                rows.push(columns.map(column => this.cell(
                    page[row][positions.get(column)!], column, render,
                )));
            }
            offset += length;
        }
        return { startRow: range.start, rows };
    }

    read_rows(sheet: number, start: number, count: number): RowWindow {
        return this.read(sheet, start, count, this.columns, true) as RowWindow;
    }

    read_columns(sheet: number, start: number, count: number, columns: readonly number[]): ColumnWindow {
        return this.read(sheet, start, count, columns, true) as ColumnWindow;
    }

    read_raw_columns(
        sheet: number,
        start: number,
        count: number,
        columns: readonly number[],
    ): RawColumnWindow {
        return this.read(sheet, start, count, columns, false);
    }

    read_rows_indexed(sheet: number, indices: ArrayLike<number>): IndexedRows {
        this.range(sheet, 0, 0);
        return {
            rows: Array.from(indices, row => {
                this.validate_row(row);
                return this.read_rows(sheet, row, 1).rows[0];
            })
        };
    }

    private validate_row(row: number): void {
        if (!Number.isInteger(row) || row < 0 || row >= this.open().nobs) {
            throw new RangeError(`row index ${row} out of range`);
        }
    }

    async read_raw_columns_async(
        sheet: number,
        start: number,
        count: number,
        columns: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<RawColumnWindow> {
        const range = this.range(sheet, start, count);
        this.validate_columns(columns);
        active(is_cancelled);
        const rows: (RawCell | null)[][] = [];
        for (let offset = 0; offset < range.count; offset += PAGE_ROWS) {
            this.open();
            active(is_cancelled);
            rows.push(...this.read_raw_columns(
                sheet,
                range.start + offset,
                Math.min(PAGE_ROWS, range.count - offset),
                columns,
            ).rows);
            await yield_to_event_loop();
        }
        this.open();
        active(is_cancelled);
        return { startRow: range.start, rows };
    }

    async read_raw_columns_indexed_async(
        sheet: number,
        indices: ArrayLike<number>,
        columns: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<IndexedRawColumns> {
        this.range(sheet, 0, 0);
        this.validate_columns(columns);
        active(is_cancelled);
        const rows: (RawCell | null)[][] = [];
        for (let i = 0; i < indices.length; i++) {
            this.open();
            active(is_cancelled);
            this.validate_row(indices[i]);
            rows.push(this.read_raw_columns(sheet, indices[i], 1, columns).rows[0]);
            if ((i + 1) % PAGE_ROWS === 0) {
                await yield_to_event_loop();
            }
        }
        this.open();
        active(is_cancelled);
        return { rows };
    }

    column_filter_metadata(sheet: number, column: number): ColumnFilterMetadata | undefined {
        this.range(sheet, 0, 0);
        this.validate_columns([column]);
        const dictionary = this.dictionary(column);
        const labels = this.labels.get(column);
        if (dictionary) {
            return {
                categoricalCodes: true,
                valueLabel: raw => {
                    if (!/^(0|[1-9]\d*)$/.test(raw)) {
                        return undefined;
                    }
                    const code = BigInt(raw);
                    return code < BigInt(dictionary.levels.length)
                        ? dictionary.levels[Number(code)] ?? 'null'
                        : undefined;
                },
            };
        }
        return labels?.size ? {
            categoricalCodes: [...labels.keys()].some(key => !/^\.[a-z]?$/.test(key)),
            valueLabel: raw => labels.get(raw),
        } : undefined;
    }

    close(): void {
        this.reader = undefined;
        this.pages.clear();
        this.cacheBytes = 0;
        this.dictionaries.clear();
        this.metadataBytes = 0;
        this.labels.clear();
        this.variables.length = 0;
        this.columns.length = 0;
    }
}
