import {
    apply_display_format,
    decode_gso_entry,
    is_legacy_format,
    is_missing_value_object,
    missing_type_to_label_key,
    parse_legacy_metadata,
    parse_metadata,
    parse_value_labels,
    read_strl_pointer,
    read_rows_from_buffer,
    type DtaMetadata,
    type GsoEntry,
    type Row,
    type RowCell,
    type VariableInfo,
} from '@jbearak/dta-parser';
import {
    assert_safe_sheet_shape,
    create_workbook_budget,
    MAX_SHEET_COLUMNS,
} from '../spreadsheet-safety';
import type {
    ColumnWindow,
    DataSource,
    IndexedRows,
    RawCell,
    RawColumnWindow,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from './interface';

const DECODE_WINDOW_ROWS = 256;
const MAX_DECODED_WINDOWS = 8;
const MAX_DECODED_CELLS = DECODE_WINDOW_ROWS * MAX_SHEET_COLUMNS;
const MAX_GSO_CACHE_ENTRIES = 256;
const GSO_KEY_OBSERVATION_RANGE = 0x1_0000_0000;
const STRLS_TAG_LENGTH = '<strls>'.length;
const VALUE_LABELS_TAG_LENGTH = '<value_labels>'.length;
const LBL_OPEN_TAG_LENGTH = '<lbl>'.length;
const LBL_CLOSE_TAG_LENGTH = '</lbl>'.length;
const LEGACY_LABEL_NAME_WIDTH = 33;
const LABEL_PADDING_BYTES = 3;
const MODERN_SECTION_TAGS: readonly [
    keyof DtaMetadata['section_offsets'],
    string,
][] = [
    ['stata_data', '<stata_dta>'],
    ['map', '<map>'],
    ['variable_types', '<variable_types>'],
    ['varnames', '<varnames>'],
    ['sortlist', '<sortlist>'],
    ['formats', '<formats>'],
    ['value_label_names', '<value_label_names>'],
    ['variable_labels', '<variable_labels>'],
    ['characteristics', '<characteristics>'],
    ['data', '<data>'],
    ['strls', '<strls>'],
    ['value_labels', '<value_labels>'],
    ['stata_data_close', '</stata_dta>'],
];

type ValueLabelTables = Map<string, Map<number, string>>;

interface CachedWindow {
    readonly rows: (RenderedCell | null)[][];
    readonly cellCount: number;
}

/** Canonical raw representation shared by display and scan reads. */
function canonicalize_stata_raw(cell: RowCell): RawCell {
    if (is_missing_value_object(cell)) {
        return { raw: cell.missing_type, rawType: 'number' };
    }
    if (typeof cell === 'string') return { raw: cell, rawType: 'string' };
    return { raw: String(cell), rawType: 'number' };
}

/** Read-only, buffer-backed Stata source with bounded lazy row decoding. */
export class DtaDataSource implements DataSource {
    private readonly _meta: WorkbookMeta;
    private readonly windows = new Map<string, CachedWindow>();
    private readonly all_columns: readonly number[];
    private readonly data_start: number;
    private bytes?: Uint8Array;
    private view?: DataView;
    private readonly pre_unicode_utf8_decoder = new TextDecoder('utf-8', { fatal: true });
    private readonly pre_unicode_fallback_decoder = new TextDecoder('windows-1252');
    private value_label_tables?: ValueLabelTables;
    private readonly gso_index = new Map<number, number>();
    private readonly gso_cache = new Map<number, string>();
    private gso_scan_position: number;
    private gso_scan_exhausted = false;

    private constructor(
        buffer: ArrayBuffer,
        private readonly metadata: DtaMetadata,
    ) {
        assert_safe_sheet_shape(
            create_workbook_budget(),
            metadata.nobs,
            metadata.nvar,
            0,
        );
        const file_bytes = new Uint8Array(buffer);
        this.data_start = metadata.section_offsets.data
            + (is_legacy_format(metadata.format_version) ? 0 : '<data>'.length);
        const data_end = this.data_start + metadata.nobs * metadata.obs_length;
        if (
            !Number.isSafeInteger(data_end)
            || data_end > buffer.byteLength
            || data_end > metadata.section_offsets.strls
        ) {
            throw new Error('Corrupt .dta file: observation data is truncated');
        }
        validate_section_offsets(metadata, file_bytes);
        this.all_columns = metadata.variables.map((_, index) => index);
        this.bytes = file_bytes;
        this.view = new DataView(buffer);
        this.gso_scan_position = metadata.section_offsets.strls
            + (is_legacy_format(metadata.format_version) ? 0 : STRLS_TAG_LENGTH);
        this._meta = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: metadata.nobs,
                sourceRowCount: metadata.nobs,
                columnCount: metadata.nvar,
                merges: [],
                hasFormatting: true,
                columnNames: metadata.variables.map((variable) => variable.name),
            }],
        };
    }

    static async create(bytes: Uint8Array): Promise<DtaDataSource> {
        const backing = bytes.buffer;
        // Buffer.slice() aliases its slab, so only preserve a backing buffer
        // when the requested bytes already occupy it exactly.
        const buffer = backing instanceof ArrayBuffer
            && bytes.byteOffset === 0
            && bytes.byteLength === backing.byteLength
            ? backing
            : new Uint8Array(bytes).buffer;
        try {
            const metadata = bytes[0] === '<'.charCodeAt(0)
                ? parse_metadata(buffer)
                : parse_legacy_metadata(buffer, buffer.byteLength);
            return new DtaDataSource(buffer, metadata);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not open Stata file: ${detail}`, { cause: error });
        }
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        this.assert_sheet(sheet_index);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.metadata.nobs);
        return {
            startRow: start,
            rows: this.read_range(start, end, this.all_columns),
        };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        for (const row of requested) this.assert_row(row);
        if (requested.length === 0) return { rows: [] };

        const materialized = new Map<number, (RenderedCell | null)[]>();
        const unique = [...new Set(requested)].sort((a, b) => a - b);
        let position = 0;
        while (position < unique.length) {
            const first = unique[position];
            let run_length = 1;
            while (
                run_length < DECODE_WINDOW_ROWS
                && position + run_length < unique.length
                && unique[position + run_length] === first + run_length
            ) run_length += 1;
            const window = this.decoded_window(first, run_length, this.all_columns);
            for (let offset = 0; offset < run_length; offset++) {
                materialized.set(first + offset, window.rows[offset]);
            }
            position += run_length;
        }
        return { rows: requested.map((row) => materialized.get(row)!) };
    }

    read_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        return this.read_column_projection(
            sheet_index,
            start_row,
            count,
            column_indices,
            (start, end, columns) => this.read_range(start, end, columns),
        );
    }

    read_raw_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): RawColumnWindow {
        return this.read_column_projection(
            sheet_index,
            start_row,
            count,
            column_indices,
            (start, end, columns) => this.read_raw_range(start, end, columns),
        );
    }

    private read_column_projection<Cell>(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        read_range: (start: number, end: number, columns: readonly number[]) => (Cell | null)[][],
    ): { startRow: number; rows: (Cell | null)[][] } {
        this.assert_sheet(sheet_index);
        for (const column of column_indices) this.assert_column(column);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.metadata.nobs);
        if (start >= end || column_indices.length === 0) {
            return { startRow: start, rows: Array.from({ length: end - start }, () => []) };
        }

        const already_ordered = column_indices.every(
            (column, index) => index === 0 || column > column_indices[index - 1],
        );
        const columns = already_ordered
            ? column_indices
            : [...new Set(column_indices)].sort((a, b) => a - b);
        const rows = read_range(start, end, columns);
        if (already_ordered) return { startRow: start, rows };

        const positions = new Map(columns.map((column, index) => [column, index]));
        return {
            startRow: start,
            rows: rows.map((row) => column_indices.map((column) => row[positions.get(column)!])),
        };
    }

    close(): void {
        this.windows.clear();
        this.value_label_tables = undefined;
        this.gso_index.clear();
        this.gso_cache.clear();
        this.gso_scan_exhausted = true;
        this.view = undefined;
        this.bytes = undefined;
    }

    private read_range(
        start: number,
        end: number,
        columns: readonly number[],
    ): (RenderedCell | null)[][] {
        const rows: (RenderedCell | null)[][] = [];
        for (let row = start; row < end;) {
            const window_start = this.window_start(row);
            const window = this.decoded_window(
                window_start,
                Math.min(DECODE_WINDOW_ROWS, this.metadata.nobs - window_start),
                columns,
            );
            const offset = row - window_start;
            const take = Math.min(window.rows.length - offset, end - row);
            rows.push(...window.rows.slice(offset, offset + take));
            row += take;
        }
        return rows;
    }

    private read_raw_range(
        start: number,
        end: number,
        columns: readonly number[],
    ): (RawCell | null)[][] {
        const rows: (RawCell | null)[][] = [];
        for (let row = start; row < end;) {
            const count = Math.min(DECODE_WINDOW_ROWS, end - row);
            const decoded = this.decode_columns(row, count, columns);
            rows.push(...decoded.map((values, row_offset) => values.map((cell, index) =>
                canonicalize_stata_raw(this.resolve_cell(
                    cell,
                    this.metadata.variables[columns[index]],
                    row + row_offset,
                )),
            )));
            row += count;
        }
        return rows;
    }

    private decoded_window(
        start: number,
        count: number,
        columns: readonly number[],
    ): CachedWindow {
        const key = `${start}:${count}:${columns.join(',')}`;
        const cached = this.windows.get(key);
        if (cached) {
            this.windows.delete(key);
            this.windows.set(key, cached);
            return cached;
        }

        const raw_rows = this.decode_columns(start, count, columns);
        const window: CachedWindow = {
            rows: raw_rows.map((row, row_offset) => row.map((cell, index) =>
                this.render_cell(
                    cell,
                    this.metadata.variables[columns[index]],
                    start + row_offset,
                ))),
            cellCount: count * columns.length,
        };
        this.windows.set(key, window);
        let cached_cells = [...this.windows.values()]
            .reduce((total, entry) => total + entry.cellCount, 0);
        while (
            this.windows.size > 1
            && (
                this.windows.size > MAX_DECODED_WINDOWS
                || cached_cells > MAX_DECODED_CELLS
            )
        ) {
            const oldest_key = this.windows.keys().next().value!;
            const oldest = this.windows.get(oldest_key)!;
            this.windows.delete(oldest_key);
            cached_cells -= oldest.cellCount;
        }
        return window;
    }

    private decode_columns(start: number, count: number, columns: readonly number[]): Row[] {
        if (columns.length === 0) return Array.from({ length: count }, () => []);
        const rows: Row[] = Array.from({ length: count }, () => []);
        let position = 0;
        while (position < columns.length) {
            const first = columns[position];
            let length = 1;
            while (
                position + length < columns.length
                && columns[position + length] === first + length
            ) length += 1;
            const decoded = read_rows_from_buffer(
                this.open_buffer(),
                this.metadata,
                start,
                count,
                first,
                first + length,
            );
            for (let row = 0; row < count; row++) rows[row].push(...(decoded[row] ?? []));
            position += length;
        }
        return rows;
    }

    private render_cell(
        cell: RowCell,
        variable: VariableInfo,
        row: number,
    ): RenderedCell {
        const resolved = this.resolve_cell(cell, variable, row);
        const raw_cell = canonicalize_stata_raw(resolved);
        if (is_missing_value_object(resolved)) {
            const labels = variable.value_label_name
                ? this.value_labels().get(variable.value_label_name)
                : undefined;
            return {
                ...raw_cell,
                formatted: labels?.get(missing_type_to_label_key(resolved.missing_type))
                    ?? resolved.missing_type,
                bold: false,
                italic: false,
            };
        }
        if (typeof resolved === 'string') {
            return {
                ...raw_cell,
                formatted: resolved,
                bold: false,
                italic: false,
            };
        }

        const labels = variable.value_label_name
            ? this.value_labels().get(variable.value_label_name)
            : undefined;
        return {
            ...raw_cell,
            formatted: labels?.get(resolved)
                ?? apply_display_format(resolved, variable.format)
                ?? raw_cell.raw!,
            bold: false,
            italic: false,
        };
    }

    private resolve_cell(
        cell: RowCell,
        variable: VariableInfo,
        row: number,
    ): RowCell {
        if (variable.type === 'strL') {
            const pointer_offset = this.data_start
                + row * this.metadata.obs_length
                + variable.byte_offset;
            const resolved = this.resolve_strl(pointer_offset);
            if (resolved === null) {
                throw new Error(`Stata strL cell at row ${row} has a dangling reference`);
            }
            return resolved;
        }
        if (
            typeof cell === 'string'
            && this.metadata.format_version < 118
        ) {
            const offset = this.data_start
                + row * this.metadata.obs_length
                + variable.byte_offset;
            return decode_fixed(
                this.open_bytes(),
                offset,
                variable.byte_width,
                this.pre_unicode_utf8_decoder,
                this.pre_unicode_fallback_decoder,
            );
        }
        return cell;
    }

    private resolve_strl(pointer_offset: number): string | null {
        const bytes = this.open_bytes();
        const view = this.open_view();
        const pointer = read_strl_cell_pointer(view, this.metadata, pointer_offset);
        if (pointer === null) return '';
        const key = gso_key(pointer.v, pointer.o);
        const cached = this.gso_cache.get(key);
        if (cached !== undefined) {
            this.gso_cache.delete(key);
            this.gso_cache.set(key, cached);
            return cached;
        }
        const indexed_content_offset = this.gso_index.get(key);
        if (indexed_content_offset !== undefined) {
            return this.decode_and_cache_gso(
                key,
                bytes,
                this.gso_entry_at(bytes, view, indexed_content_offset),
            );
        }

        while (!this.gso_scan_exhausted) {
            const entry = this.scan_next_gso(bytes, view);
            if (entry === null) break;
            if (entry.key === key) {
                return this.decode_and_cache_gso(key, bytes, entry.value);
            }
        }
        return null;
    }

    private scan_next_gso(
        bytes: Uint8Array,
        view: DataView,
    ): { key: number; value: GsoEntry } | null {
        const section_end = this.metadata.section_offsets.value_labels;
        let position = this.gso_scan_position;
        if (
            position + 3 > section_end
            || bytes[position] !== 0x47
            || bytes[position + 1] !== 0x53
            || bytes[position + 2] !== 0x4f
        ) {
            this.gso_scan_exhausted = true;
            return null;
        }
        position += 3;
        const little_endian = this.metadata.byte_order === 'LSF';
        const variable = view.getUint32(position, little_endian);
        position += 4;
        let observation: number;
        if (this.metadata.format_version === 117) {
            observation = view.getUint32(position, little_endian);
            position += 4;
        } else if (little_endian) {
            observation = view.getUint32(position, true);
            if (view.getUint32(position + 4, true) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
            position += 8;
        } else {
            if (view.getUint32(position, false) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
            observation = view.getUint32(position + 4, false);
            position += 8;
        }
        const type = bytes[position++];
        const content_length = view.getUint32(position, little_endian);
        position += 4;
        const content_end = position + content_length;
        if (!Number.isSafeInteger(content_end) || content_end > section_end) {
            throw new Error('Corrupt .dta file: strL object is truncated');
        }
        const key = gso_key(variable, observation);
        const value = { content_offset: position, content_length, type };
        this.gso_scan_position = content_end;
        this.gso_index.set(key, position);
        return { key, value };
    }

    private gso_entry_at(
        bytes: Uint8Array,
        view: DataView,
        content_offset: number,
    ): GsoEntry {
        return {
            content_offset,
            content_length: view.getUint32(
                content_offset - 4,
                this.metadata.byte_order === 'LSF',
            ),
            type: bytes[content_offset - 5],
        };
    }

    private decode_and_cache_gso(
        key: number,
        bytes: Uint8Array,
        entry: GsoEntry,
    ): string {
        const decoded = this.decode_gso(bytes, entry);
        this.gso_cache.set(key, decoded);
        if (this.gso_cache.size > MAX_GSO_CACHE_ENTRIES) {
            this.gso_cache.delete(this.gso_cache.keys().next().value!);
        }
        return decoded;
    }

    private decode_gso(bytes: Uint8Array, entry: GsoEntry): string {
        if (entry.type === 129) {
            return encode_binary_gso(bytes, entry);
        }
        if (this.metadata.format_version >= 118 || entry.type !== 130) {
            return decode_gso_entry(bytes, entry);
        }
        const content_length = entry.content_length > 0
            ? entry.content_length - 1
            : 0;
        return decode_pre_unicode(
            bytes,
            entry.content_offset,
            entry.content_offset + content_length,
            this.pre_unicode_utf8_decoder,
            this.pre_unicode_fallback_decoder,
        );
    }

    private open_buffer(): ArrayBuffer {
        const buffer = this.open_bytes().buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected an ArrayBuffer');
        return buffer;
    }

    private open_bytes(): Uint8Array {
        if (this.bytes === undefined) throw new Error('Stata source is closed');
        return this.bytes;
    }

    private open_view(): DataView {
        if (this.view === undefined) throw new Error('Stata source is closed');
        return this.view;
    }

    private value_labels(): ValueLabelTables {
        this.value_label_tables ??= this.metadata.format_version < 118
            ? parse_pre_unicode_value_labels(
                this.open_buffer(),
                this.metadata,
                this.pre_unicode_utf8_decoder,
                this.pre_unicode_fallback_decoder,
            )
            : parse_value_labels(this.open_buffer(), this.metadata);
        return this.value_label_tables;
    }

    private window_start(row: number): number {
        return Math.floor(row / DECODE_WINDOW_ROWS) * DECODE_WINDOW_ROWS;
    }

    private clamp_start(start: number): number {
        return Math.max(0, Math.min(start, this.metadata.nobs));
    }

    private assert_sheet(sheet_index: number): void {
        if (!Number.isInteger(sheet_index) || sheet_index !== 0) {
            throw new RangeError(`sheet index ${sheet_index} out of range (1 sheet)`);
        }
    }

    private assert_row(row: number): void {
        if (!Number.isInteger(row) || row < 0 || row >= this.metadata.nobs) {
            throw new RangeError(`row index ${row} out of range (${this.metadata.nobs} rows)`);
        }
    }

    private assert_column(column: number): void {
        if (!Number.isInteger(column) || column < 0 || column >= this.metadata.nvar) {
            throw new RangeError(`column index ${column} out of range (${this.metadata.nvar} columns)`);
        }
    }
}

function encode_binary_gso(bytes: Uint8Array, entry: GsoEntry): string {
    let encoded = 'hex:';
    const end = entry.content_offset + entry.content_length;
    for (let chunk_start = entry.content_offset; chunk_start < end; chunk_start += 4096) {
        const chunk_end = Math.min(chunk_start + 4096, end);
        let chunk = '';
        for (let offset = chunk_start; offset < chunk_end; offset++) {
            chunk += bytes[offset].toString(16).padStart(2, '0');
        }
        encoded += chunk;
    }
    return encoded;
}

function read_strl_cell_pointer(
    view: DataView,
    metadata: DtaMetadata,
    pointer_offset: number,
): { v: number; o: number } | null {
    if (metadata.format_version !== 119) {
        return read_strl_pointer(view, metadata, pointer_offset);
    }
    const little_endian = metadata.byte_order === 'LSF';
    let variable: number;
    let observation: number;
    if (little_endian) {
        variable = view.getUint16(pointer_offset, true)
            + view.getUint8(pointer_offset + 2) * 0x1_0000;
        observation = view.getUint32(pointer_offset + 3, true);
        if (view.getUint8(pointer_offset + 7) !== 0) {
            throw new Error('strL observation number exceeds 32-bit range');
        }
    } else {
        variable = view.getUint8(pointer_offset) * 0x1_0000
            + view.getUint16(pointer_offset + 1, false);
        if (view.getUint8(pointer_offset + 3) !== 0) {
            throw new Error('strL observation number exceeds 32-bit range');
        }
        observation = view.getUint32(pointer_offset + 4, false);
    }
    return variable === 0 && observation === 0
        ? null
        : { v: variable, o: observation };
}

function gso_key(variable: number, observation: number): number {
    return variable * GSO_KEY_OBSERVATION_RANGE + observation;
}

function validate_section_offsets(metadata: DtaMetadata, bytes: Uint8Array): void {
    let previous = -1;
    for (const [name, offset] of Object.entries(metadata.section_offsets)) {
        if (!Number.isSafeInteger(offset) || offset < previous || offset > bytes.byteLength) {
            throw new Error(`Corrupt .dta file: invalid ${name} section offset`);
        }
        previous = offset;
    }
    if (is_legacy_format(metadata.format_version)) return;
    for (const [name, tag] of MODERN_SECTION_TAGS) {
        if (!matches_ascii(bytes, metadata.section_offsets[name], tag)) {
            throw new Error(`Corrupt .dta file: invalid ${name} section tag`);
        }
    }
}

function parse_pre_unicode_value_labels(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    utf8_decoder: TextDecoder,
    fallback_decoder: TextDecoder,
): ValueLabelTables {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const little_endian = metadata.byte_order === 'LSF';
    const legacy = is_legacy_format(metadata.format_version);
    const section_end = metadata.section_offsets.stata_data_close;
    let position = metadata.section_offsets.value_labels
        + (legacy ? 0 : VALUE_LABELS_TAG_LENGTH);
    const result: ValueLabelTables = new Map();

    while (position < section_end) {
        let table_length: number;
        if (legacy) {
            if (position + 4 > section_end) break;
            table_length = view.getInt32(position, little_endian);
            if (table_length <= 0) break;
            position += 4;
        } else {
            if (!matches_ascii(bytes, position, '<lbl>')) break;
            position += LBL_OPEN_TAG_LENGTH;
            if (position + 4 > section_end) {
                throw new Error('Corrupt value label table: truncated entry length');
            }
            table_length = view.getInt32(position, little_endian);
            position += 4;
            if (table_length < 0) {
                throw new Error('Corrupt value label table: negative entry length');
            }
        }
        const entry_end = position + table_length;
        if (!Number.isSafeInteger(entry_end) || entry_end > section_end) {
            throw new Error('Corrupt value label table: entry exceeds section bounds');
        }
        const name = decode_fixed(
            bytes,
            position,
            LEGACY_LABEL_NAME_WIDTH,
            utf8_decoder,
            fallback_decoder,
        );
        position += LEGACY_LABEL_NAME_WIDTH + LABEL_PADDING_BYTES;
        if (position + 8 > entry_end) {
            throw new Error('Corrupt value label table: truncated header');
        }
        const count = view.getInt32(position, little_endian);
        const text_length = view.getInt32(position + 4, little_endian);
        position += 8;
        if (count < 0 || text_length < 0) {
            throw new Error('Corrupt value label table: negative count or text length');
        }
        const payload_end = position + count * 8 + text_length;
        if (!Number.isSafeInteger(payload_end) || payload_end > entry_end) {
            throw new Error('Corrupt value label table: payload exceeds entry bounds');
        }
        const offsets_start = position;
        const values_start = offsets_start + count * 4;
        const text_start = values_start + count * 4;
        const labels = new Map<number, string>();
        for (let index = 0; index < count; index++) {
            const offset = view.getInt32(offsets_start + index * 4, little_endian);
            if (offset < 0 || offset >= text_length) continue;
            const start = text_start + offset;
            let end = start;
            while (end < text_start + text_length && bytes[end] !== 0) end += 1;
            const value = view.getInt32(values_start + index * 4, little_endian);
            labels.set(value, decode_pre_unicode(
                bytes,
                start,
                end,
                utf8_decoder,
                fallback_decoder,
            ));
        }
        result.set(name, labels);
        position = entry_end;
        if (!legacy) {
            if (!matches_ascii(bytes, position, '</lbl>')) {
                throw new Error('Corrupt value label table: missing closing tag');
            }
            position += LBL_CLOSE_TAG_LENGTH;
        }
    }
    return result;
}

function decode_fixed(
    bytes: Uint8Array,
    start: number,
    width: number,
    utf8_decoder: TextDecoder,
    fallback_decoder: TextDecoder,
): string {
    let end = start;
    while (end < start + width && bytes[end] !== 0) end += 1;
    return decode_pre_unicode(bytes, start, end, utf8_decoder, fallback_decoder);
}

function decode_pre_unicode(
    bytes: Uint8Array,
    start: number,
    end: number,
    utf8_decoder: TextDecoder,
    fallback_decoder: TextDecoder,
): string {
    const value = bytes.subarray(start, end);
    try {
        return utf8_decoder.decode(value);
    } catch {
        return fallback_decoder.decode(value);
    }
}

function matches_ascii(bytes: Uint8Array, start: number, value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        if (bytes[start + index] !== value.charCodeAt(index)) return false;
    }
    return true;
}
