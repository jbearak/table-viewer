import { createHash } from 'node:crypto';
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
const MAX_GSO_INDEX_ENTRIES = 1_024;
const MAX_GSO_CHECKPOINTS = 1_024;
const MAX_GSO_DIGEST_CACHE_ENTRIES = 4_096;
const MAX_LEGACY_EXPANSION_FIELDS = 10_000;
const INITIAL_GSO_CHECKPOINT_STRIDE = 64;
const BINARY_GSO_PREVIEW_BYTES = 32;
const BINARY_GSO_COMPARISON_PREFIX = 'stata-binary:sha256:';
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

interface BinaryGso {
    readonly kind: 'binary-gso';
    readonly contentOffset: number;
    readonly contentLength: number;
    readonly formatted: string;
}

type DecodedGso = string | BinaryGso;
type ResolvedStataCell = RowCell | BinaryGso;

interface GsoOrder {
    readonly observation: number;
    readonly variable: number;
}

interface GsoCheckpoint extends GsoOrder {
    readonly position: number;
}

interface ScannedGso extends GsoOrder {
    readonly key: string;
    readonly value: GsoEntry;
    readonly nextPosition: number;
}

interface GsoBatchTarget extends GsoOrder {
    readonly key: string;
    readonly pointerOffsets: number[];
}

interface CachedWindow {
    readonly rows: (RenderedCell | null)[][];
    readonly cellCount: number;
}

/** Canonical raw representation shared by display and scan reads. */
function canonicalize_stata_raw(
    cell: ResolvedStataCell,
    binary_comparison_key: (cell: BinaryGso) => string,
): RawCell {
    if (is_binary_gso(cell)) {
        const raw_cell: RawCell = { raw: cell.formatted, rawType: 'string' };
        Object.defineProperty(raw_cell, 'comparisonKey', {
            enumerable: false,
            get: () => binary_comparison_key(cell),
        });
        return raw_cell;
    }
    if (is_missing_value_object(cell)) {
        return { raw: cell.missing_type, rawType: 'number' };
    }
    if (typeof cell === 'string') return { raw: cell, rawType: 'string' };
    return { raw: String(cell), rawType: 'number' };
}

function rendered_stata_cell(raw_cell: RawCell, formatted: string): RenderedCell {
    const rendered: RenderedCell = {
        raw: raw_cell.raw,
        rawType: raw_cell.rawType,
        formatted,
        bold: false,
        italic: false,
    };
    const comparison_key = Object.getOwnPropertyDescriptor(raw_cell, 'comparisonKey');
    if (comparison_key !== undefined) {
        Object.defineProperty(rendered, 'comparisonKey', comparison_key);
    }
    return rendered;
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
    private readonly gso_index = new Map<string, GsoEntry>();
    private readonly gso_cache = new Map<string, DecodedGso>();
    private readonly gso_digest_cache = new Map<number, string>();
    private gso_checkpoints: GsoCheckpoint[] = [];
    private gso_checkpoint_stride = INITIAL_GSO_CHECKPOINT_STRIDE;
    private gso_entries_scanned = 0;
    private gso_order_monotonic = true;
    private gso_last_order?: GsoOrder;
    private readonly gso_start_position: number;
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
        this.gso_start_position = metadata.section_offsets.strls
            + (is_legacy_format(metadata.format_version) ? 0 : STRLS_TAG_LENGTH);
        this.gso_scan_position = this.gso_start_position;
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
                : (validate_legacy_expansion_fields(buffer),
                    parse_legacy_metadata(buffer, buffer.byteLength));
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
        this.gso_digest_cache.clear();
        this.gso_checkpoints = [];
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
            const decoded = this.resolve_columns(
                this.decode_columns(row, count, columns),
                row,
                columns,
            );
            rows.push(...decoded.map((values) => values.map((cell) =>
                canonicalize_stata_raw(
                    cell,
                    (binary) => this.binary_comparison_key(binary),
                ),
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

        const raw_rows = this.resolve_columns(
            this.decode_columns(start, count, columns),
            start,
            columns,
        );
        const window: CachedWindow = {
            rows: raw_rows.map((row) => row.map((cell, index) =>
                this.render_cell(cell, this.metadata.variables[columns[index]]))),
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
        resolved: ResolvedStataCell,
        variable: VariableInfo,
    ): RenderedCell {
        const raw_cell = canonicalize_stata_raw(
            resolved,
            (binary) => this.binary_comparison_key(binary),
        );
        if (is_missing_value_object(resolved)) {
            const labels = variable.value_label_name
                ? this.value_labels().get(variable.value_label_name)
                : undefined;
            return rendered_stata_cell(
                raw_cell,
                labels?.get(missing_type_to_label_key(resolved.missing_type))
                    ?? resolved.missing_type,
            );
        }
        if (is_binary_gso(resolved) || typeof resolved === 'string') {
            return rendered_stata_cell(
                raw_cell,
                is_binary_gso(resolved) ? resolved.formatted : resolved,
            );
        }

        const labels = variable.value_label_name
            ? this.value_labels().get(variable.value_label_name)
            : undefined;
        return rendered_stata_cell(
            raw_cell,
            labels?.get(resolved)
                ?? apply_display_format(resolved, variable.format)
                ?? raw_cell.raw!,
        );
    }

    private resolve_columns(
        rows: Row[],
        start: number,
        columns: readonly number[],
    ): ResolvedStataCell[][] {
        const resolved_strls = this.resolve_strl_batch(start, rows.length, columns);
        return rows.map((row, row_offset) => row.map((cell, index) =>
            this.resolve_cell(
                cell,
                this.metadata.variables[columns[index]],
                start + row_offset,
                resolved_strls,
            )));
    }

    private resolve_cell(
        cell: RowCell,
        variable: VariableInfo,
        row: number,
        resolved_strls: ReadonlyMap<number, DecodedGso>,
    ): ResolvedStataCell {
        if (variable.type === 'strL') {
            const pointer_offset = this.data_start
                + row * this.metadata.obs_length
                + variable.byte_offset;
            const resolved = resolved_strls.get(pointer_offset);
            if (resolved === undefined) {
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

    private resolve_strl_batch(
        start: number,
        count: number,
        columns: readonly number[],
    ): ReadonlyMap<number, DecodedGso> {
        const strl_columns = columns.filter(
            (column) => this.metadata.variables[column].type === 'strL',
        );
        if (strl_columns.length === 0) return new Map();
        const view = this.open_view();
        const resolved = new Map<number, DecodedGso>();
        const targets = new Map<string, GsoBatchTarget>();
        for (let row_offset = 0; row_offset < count; row_offset++) {
            for (const column of strl_columns) {
                const variable = this.metadata.variables[column];
                const pointer_offset = this.data_start
                    + (start + row_offset) * this.metadata.obs_length
                    + variable.byte_offset;
                const pointer = read_strl_cell_pointer(view, this.metadata, pointer_offset);
                if (pointer === null) {
                    resolved.set(pointer_offset, '');
                    continue;
                }
                validate_gso_identifier(pointer.v, pointer.o, this.metadata, 'strL pointer');
                const key = gso_key(pointer.v, pointer.o);
                const target = targets.get(key);
                if (target === undefined) {
                    targets.set(key, {
                        key,
                        observation: pointer.o,
                        variable: pointer.v,
                        pointerOffsets: [pointer_offset],
                    });
                } else {
                    target.pointerOffsets.push(pointer_offset);
                }
            }
        }
        if (targets.size === 0) return resolved;

        const values = new Map<string, DecodedGso>();
        const unresolved: GsoBatchTarget[] = [];
        const bytes = this.open_bytes();
        for (const target of targets.values()) {
            const cached = this.find_cached_gso(target.key, bytes);
            if (cached === undefined) unresolved.push(target);
            else values.set(target.key, cached);
        }
        if (unresolved.length > 0) {
            this.resolve_gso_batch(bytes, view, unresolved, values);
        }
        for (const target of targets.values()) {
            const value = values.get(target.key);
            if (value === undefined) continue;
            for (const pointer_offset of target.pointerOffsets) {
                resolved.set(pointer_offset, value);
            }
        }
        return resolved;
    }

    private resolve_gso_batch(
        bytes: Uint8Array,
        view: DataView,
        targets: GsoBatchTarget[],
        values: Map<string, DecodedGso>,
    ): void {
        const ordered = this.gso_order_monotonic;
        const first = targets.reduce((minimum, target) =>
            compare_gso_order(target, minimum) < 0 ? target : minimum);
        let position = this.gso_start_position;
        if (ordered) {
            if (
                !this.gso_scan_exhausted
                && this.gso_last_order !== undefined
                && compare_gso_order(this.gso_last_order, first) < 0
            ) {
                position = this.gso_scan_position;
            } else {
                position = this.gso_checkpoint_position(first);
            }
        }

        const requested = new Set(targets.map((target) => target.key));
        const initial_frontier = this.gso_scan_position;
        const scan_ranges = !ordered && !this.gso_scan_exhausted
            && initial_frontier > this.gso_start_position
            ? [
                { start: initial_frontier, end: this.metadata.section_offsets.value_labels },
                { start: this.gso_start_position, end: initial_frontier },
            ]
            : [{ start: position, end: this.metadata.section_offsets.value_labels }];
        for (const range of scan_ranges) {
            position = range.start;
            while (position < range.end) {
                const historical = position < this.gso_scan_position;
                const scanned = historical
                    ? this.read_gso_at(bytes, view, position)
                    : this.scan_next_gso(bytes, view);
                if (scanned === null) break;
                if (requested.delete(scanned.key)) {
                    if (historical) this.cache_gso_entry(scanned.key, scanned.value);
                    values.set(
                        scanned.key,
                        this.decode_and_cache_gso(scanned.key, bytes, scanned.value),
                    );
                    if (requested.size === 0) return;
                }
                position = scanned.nextPosition;
            }
        }
    }

    private scan_next_gso(bytes: Uint8Array, view: DataView): ScannedGso | null {
        const position = this.gso_scan_position;
        const scanned = this.read_gso_at(bytes, view, position);
        if (scanned === null) {
            this.gso_scan_exhausted = true;
            return null;
        }
        this.gso_scan_position = scanned.nextPosition;
        this.remember_gso(scanned, position);
        return scanned;
    }

    private read_gso_at(
        bytes: Uint8Array,
        view: DataView,
        start: number,
    ): ScannedGso | null {
        const section_end = this.metadata.section_offsets.value_labels;
        let position = start;
        if (
            position + 3 > section_end
            || bytes[position] !== 0x47
            || bytes[position + 1] !== 0x53
            || bytes[position + 2] !== 0x4f
        ) return null;
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
        validate_gso_identifier(variable, observation, this.metadata, 'strL object');
        const type = bytes[position++];
        const content_length = view.getUint32(position, little_endian);
        position += 4;
        const content_end = position + content_length;
        if (!Number.isSafeInteger(content_end) || content_end > section_end) {
            throw new Error('Corrupt .dta file: strL object is truncated');
        }
        return {
            key: gso_key(variable, observation),
            observation,
            variable,
            value: { content_offset: position, content_length, type },
            nextPosition: content_end,
        };
    }

    private remember_gso(scanned: ScannedGso, position: number): void {
        this.cache_gso_entry(scanned.key, scanned.value);
        const order = { observation: scanned.observation, variable: scanned.variable };
        if (
            this.gso_last_order !== undefined
            && compare_gso_order(order, this.gso_last_order) < 0
        ) this.gso_order_monotonic = false;
        this.gso_last_order = order;
        if (this.gso_entries_scanned % this.gso_checkpoint_stride === 0) {
            this.gso_checkpoints.push({ ...order, position });
            if (this.gso_checkpoints.length > MAX_GSO_CHECKPOINTS) {
                this.gso_checkpoints = this.gso_checkpoints.filter((_, index) => index % 2 === 0);
                this.gso_checkpoint_stride *= 2;
            }
        }
        this.gso_entries_scanned += 1;
    }

    private cache_gso_entry(key: string, entry: GsoEntry): void {
        this.gso_index.delete(key);
        this.gso_index.set(key, entry);
        if (this.gso_index.size > MAX_GSO_INDEX_ENTRIES) {
            this.gso_index.delete(this.gso_index.keys().next().value!);
        }
    }

    private find_cached_gso(key: string, bytes: Uint8Array): DecodedGso | undefined {
        const cached = this.gso_cache.get(key);
        if (cached !== undefined) {
            this.gso_cache.delete(key);
            this.gso_cache.set(key, cached);
            return cached;
        }
        const indexed = this.gso_index.get(key);
        if (indexed === undefined) return undefined;
        this.cache_gso_entry(key, indexed);
        return this.decode_and_cache_gso(key, bytes, indexed);
    }

    private gso_checkpoint_position(target_order: GsoOrder): number {
        let low = 0;
        let high = this.gso_checkpoints.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (compare_gso_order(this.gso_checkpoints[middle], target_order) <= 0) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low > 0
            ? this.gso_checkpoints[low - 1].position
            : this.gso_start_position;
    }

    private decode_and_cache_gso(
        key: string,
        bytes: Uint8Array,
        entry: GsoEntry,
    ): DecodedGso {
        const decoded = this.decode_gso(bytes, entry);
        this.gso_cache.set(key, decoded);
        if (this.gso_cache.size > MAX_GSO_CACHE_ENTRIES) {
            this.gso_cache.delete(this.gso_cache.keys().next().value!);
        }
        return decoded;
    }

    private decode_gso(bytes: Uint8Array, entry: GsoEntry): DecodedGso {
        if (entry.type === 129) return encode_binary_gso(bytes, entry);
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

    private binary_comparison_key(binary: BinaryGso): string {
        let digest = this.gso_digest_cache.get(binary.contentOffset);
        if (digest === undefined) {
            const content = this.open_bytes().subarray(
                binary.contentOffset,
                binary.contentOffset + binary.contentLength,
            );
            digest = createHash('sha256').update(content).digest('hex');
            this.gso_digest_cache.set(binary.contentOffset, digest);
            if (this.gso_digest_cache.size > MAX_GSO_DIGEST_CACHE_ENTRIES) {
                this.gso_digest_cache.delete(this.gso_digest_cache.keys().next().value!);
            }
        }
        return `${BINARY_GSO_COMPARISON_PREFIX}${digest}:${binary.contentLength}`;
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

function encode_binary_gso(bytes: Uint8Array, entry: GsoEntry): BinaryGso {
    const preview_length = Math.min(entry.content_length, BINARY_GSO_PREVIEW_BYTES);
    let preview = '';
    for (let offset = 0; offset < preview_length; offset++) {
        preview += bytes[entry.content_offset + offset].toString(16).padStart(2, '0');
    }
    const suffix = entry.content_length > preview_length ? '…' : '';
    return {
        kind: 'binary-gso',
        contentOffset: entry.content_offset,
        contentLength: entry.content_length,
        formatted: `binary (${entry.content_length} bytes): ${preview}${suffix}`,
    };
}

function compare_gso_order(left: GsoOrder, right: GsoOrder): number {
    return left.observation - right.observation || left.variable - right.variable;
}

function is_binary_gso(cell: ResolvedStataCell): cell is BinaryGso {
    return typeof cell === 'object' && cell !== null && 'kind' in cell
        && cell.kind === 'binary-gso';
}

function validate_legacy_expansion_fields(buffer: ArrayBuffer): void {
    const bytes = new Uint8Array(buffer);
    const version = bytes[0];
    if (version !== 113 && version !== 114 && version !== 115) return;
    if (buffer.byteLength < 10) throw new Error('Corrupt .dta file: legacy header is truncated');
    const little_endian = bytes[1] === 2;
    const view = new DataView(buffer);
    const nvar = view.getUint16(4, little_endian);
    const format_width = version === 113 ? 12 : 49;
    let position = 109
        + nvar
        + nvar * 33
        + (nvar + 1) * 2
        + nvar * format_width
        + nvar * 33
        + nvar * 81;
    for (let field = 0; field <= MAX_LEGACY_EXPANSION_FIELDS; field++) {
        if (field === MAX_LEGACY_EXPANSION_FIELDS) {
            throw new Error('Corrupt .dta file: too many expansion fields');
        }
        if (!Number.isSafeInteger(position) || position + 5 > buffer.byteLength) {
            throw new Error('Corrupt .dta file: expansion fields are truncated');
        }
        const type = view.getUint8(position);
        const length = view.getInt32(position + 1, little_endian);
        if (length < 0) {
            throw new Error('Corrupt .dta file: expansion field has negative length');
        }
        const next = position + 5 + length;
        if (!Number.isSafeInteger(next) || next <= position || next > buffer.byteLength) {
            throw new Error('Corrupt .dta file: expansion field is truncated');
        }
        if (type === 0 && length === 0) return;
        position = next;
    }
}

function read_strl_cell_pointer(
    view: DataView,
    metadata: DtaMetadata,
    pointer_offset: number,
): { v: number; o: number } | null {
    if (metadata.format_version !== 118 && metadata.format_version !== 119) {
        return read_strl_pointer(view, metadata, pointer_offset);
    }
    const little_endian = metadata.byte_order === 'LSF';
    let variable: number;
    let observation: number;
    if (metadata.format_version === 118) {
        // Remove this workaround once @jbearak/dta-parser includes the fix for
        // jbearak/dta-parser#37. Release 118 uses a 2-byte v and 6-byte o.
        variable = view.getUint16(pointer_offset, little_endian);
        if (little_endian) {
            observation = view.getUint32(pointer_offset + 2, true);
            if (view.getUint16(pointer_offset + 6, true) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
        } else {
            if (view.getUint16(pointer_offset + 2, false) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
            observation = view.getUint32(pointer_offset + 4, false);
        }
    } else if (little_endian) {
        // Release 119 uses a 3-byte v and 5-byte o.
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

function validate_gso_identifier(
    variable: number,
    observation: number,
    metadata: DtaMetadata,
    source: 'strL pointer' | 'strL object',
): void {
    if (
        !Number.isInteger(variable)
        || !Number.isInteger(observation)
        || variable < 1
        || variable > metadata.nvar
        || observation < 1
        || observation > metadata.nobs
    ) {
        throw new Error(
            `Corrupt .dta file: ${source} id (${variable}, ${observation}) is outside `
            + `the dataset range (1..${metadata.nvar}, 1..${metadata.nobs})`,
        );
    }
}

function gso_key(variable: number, observation: number): string {
    return `${variable}:${observation}`;
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
