import type {
    ColumnWindow,
    DataSource,
    ExcelHeaderOverride,
    IndexedRows,
    RenderedCell,
    RowWindow,
    SheetMeta,
    WorkbookMeta,
} from './interface';
import {
    projected_row_for_source,
    read_source_columns,
    read_source_row_indices,
    read_source_rows_indexed,
} from './interface';
import type { MergeRange } from '../types';
import { sanitize_excel_header_overrides } from '../types';

const DETECTION_DATA_ROWS = 32;
const DETECTION_MAX_COLUMNS = 256;
const HEADER_MAX_LENGTH = 80;

interface SheetProjection {
    physical: SheetMeta;
    firstRowColumnNames: string[];
    manualColumnNames: string[];
    manualHeaderRow?: number;
    manualHeaderSourceRow?: number;
    detected: boolean;
    override?: ExcelHeaderOverride;
}

export interface ExcelHeaderOverridePlan {
    sheetIndex: number;
    sheet: SheetMeta;
    previousMode: ExcelHeaderOverride | 'auto';
    nextMode: ExcelHeaderOverride | 'auto';
    previousActive: boolean;
    nextActive: boolean;
}

export interface ExcelHeaderPlanningSheet {
    readonly name: string;
    readonly rowCount: number;
    readonly sourceRowCount: number;
    readonly columnCount: number;
    readonly merges: readonly Readonly<MergeRange>[];
    readonly hasFormatting: boolean;
    readonly columnNames: readonly string[];
    readonly manualColumnNames?: readonly string[];
    readonly manualHeaderRow?: number;
    readonly manualHeaderSourceRow?: number;
    readonly detected: boolean;
    readonly override?: ExcelHeaderOverride;
}

export interface ExcelHeaderPlanningInput {
    readonly hasFormatting: boolean;
    readonly sheets: readonly ExcelHeaderPlanningSheet[];
}

/**
 * Projects an already-parsed Excel workbook without changing its physical data.
 * The first row can become column names independently for each worksheet, while
 * toggles remain cheap because the underlying XLS/XLSX source is never reparsed.
 */
export class ExcelHeaderDataSource implements DataSource {
    private readonly sheets: SheetProjection[];
    private _meta: WorkbookMeta;
    private closed = false;

    constructor(
        private readonly base: DataSource,
        overrides?: Record<string, ExcelHeaderOverride>,
        hidden_rows?: readonly (readonly number[] | undefined)[],
    ) {
        const sanitized = sanitize_excel_header_overrides(overrides);
        const physical_meta = base.meta();
        this.sheets = physical_meta.sheets.map((sheet, sheet_index) => {
            const first_row = sheet.rowCount > 0
                ? base.read_rows(sheet_index, 0, 1).rows[0]
                : undefined;
            let detected = false;
            if (detection_structure_is_eligible(sheet)) {
                const body_count = Math.min(
                    sheet.rowCount - 1,
                    DETECTION_DATA_ROWS,
                );
                const body_rows = body_count > 0
                    ? base.read_rows(sheet_index, 1, body_count).rows
                    : [];
                detected = detect_first_row_as_header(
                    sheet,
                    [first_row ?? [], ...body_rows],
                );
            }
            const projection: SheetProjection = {
                physical: sheet,
                firstRowColumnNames: first_row_names(sheet, first_row),
                manualColumnNames: [],
                detected,
                override: override_for(sanitized, sheet.name),
            };
            this.update_manual_candidate(
                projection,
                sheet_index,
                hidden_rows?.[sheet_index],
                first_row,
            );
            return projection;
        });
        this._meta = this.build_meta();
    }

    get warnings(): string[] | undefined {
        return this.base.warnings;
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    source_row_indices(
        sheet_index: number,
        projected_rows: ArrayLike<number>,
    ): Uint32Array {
        const projection = this.sheets[sheet_index];
        if (!projection) {
            throw new RangeError(
                `sheet index ${sheet_index} out of range (${this.sheets.length} sheets)`,
            );
        }
        const header_row = active_header_row(projection, projection.override);
        if (header_row === undefined) {
            return read_source_row_indices(this.base, sheet_index, projected_rows);
        }
        const base_rows = Uint32Array.from(
            projected_rows,
            (row) => row < header_row ? row : row + 1,
        );
        return read_source_row_indices(this.base, sheet_index, base_rows);
    }

    projected_row_index(
        sheet_index: number,
        source_row: number,
    ): number | undefined {
        const projection = this.sheets[sheet_index];
        if (!projection) {
            throw new RangeError(
                `sheet index ${sheet_index} out of range (${this.sheets.length} sheets)`,
            );
        }
        const base_row = projected_row_for_source(this.base, sheet_index, source_row);
        if (base_row === undefined) return undefined;
        const header_row = active_header_row(projection, projection.override);
        if (header_row === undefined) return base_row;
        if (base_row === header_row) return undefined;
        return base_row < header_row ? base_row : base_row - 1;
    }

    /** Immutable facts used by pure state planning and CAS conflict retries. */
    planning_input(): ExcelHeaderPlanningInput {
        return this.planning_input_with_candidate();
    }

    /** Immutable projection facts for atomically promoting a specific source row. */
    planning_input_for_header_source(
        sheet_name: string,
        source_row: number,
    ): ExcelHeaderPlanningInput | undefined {
        const sheet_index = this.sheets.findIndex(
            (sheet) => sheet.physical.name === sheet_name,
        );
        const sheet = this.sheets[sheet_index];
        if (!sheet || !Number.isInteger(source_row) || source_row < 0) return undefined;
        const projected_row = projected_row_for_source(
            this.base,
            sheet_index,
            source_row,
        );
        if (projected_row === undefined) return undefined;
        const row = this.base.read_rows(sheet_index, projected_row, 1).rows[0];
        return this.planning_input_with_candidate({
            sheetIndex: sheet_index,
            projectedRow: projected_row,
            sourceRow: source_row,
            columnNames: first_row_names(sheet.physical, row),
        });
    }

    private planning_input_with_candidate(candidate?: {
        sheetIndex: number;
        projectedRow: number;
        sourceRow: number;
        columnNames: readonly string[];
    }): ExcelHeaderPlanningInput {
        return Object.freeze({
            hasFormatting: this.base.meta().hasFormatting,
            sheets: Object.freeze(this.sheets.map((sheet, sheet_index) => {
                const selected = candidate?.sheetIndex === sheet_index
                    ? candidate
                    : undefined;
                return Object.freeze({
                    name: sheet.physical.name,
                    rowCount: sheet.physical.rowCount,
                    sourceRowCount: sheet.physical.sourceRowCount,
                    columnCount: sheet.physical.columnCount,
                    merges: Object.freeze(
                        sheet.physical.merges.map((merge) => Object.freeze({ ...merge })),
                    ),
                    hasFormatting: sheet.physical.hasFormatting,
                    columnNames: Object.freeze([...sheet.firstRowColumnNames]),
                    manualColumnNames: Object.freeze([...(selected
                        ? selected.columnNames
                        : sheet.manualColumnNames)]),
                    manualHeaderRow: selected?.projectedRow ?? sheet.manualHeaderRow,
                    manualHeaderSourceRow: selected?.sourceRow
                        ?? sheet.manualHeaderSourceRow,
                    detected: sheet.detected,
                    override: sheet.override,
                });
            })),
        });
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const projection = this.sheets[sheet_index];
        if (!projection) {
            throw new RangeError(
                `sheet index ${sheet_index} out of range (${this.sheets.length} sheets)`,
            );
        }
        const header_row = active_header_row(projection, projection.override);
        if (header_row === undefined) {
            return this.base.read_rows(sheet_index, start_row, count);
        }

        const row_count = Math.max(0, projection.physical.rowCount - 1);
        const start = Math.max(0, Math.min(start_row, row_count));
        const requested = Math.max(0, count);
        const available = Math.min(requested, row_count - start);
        if (available <= 0) return { startRow: start, rows: [] };

        const physical_indices = Array.from(
            { length: available },
            (_, offset) => {
                const row = start + offset;
                return row < header_row ? row : row + 1;
            },
        );
        return {
            startRow: start,
            rows: read_source_rows_indexed(
                this.base,
                sheet_index,
                physical_indices,
            ).rows,
        };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        const projection = this.sheets[sheet_index];
        if (!projection) {
            throw new RangeError(
                `sheet index ${sheet_index} out of range (${this.sheets.length} sheets)`,
            );
        }
        const requested = Array.from(row_indices);
        const header_row = active_header_row(projection, projection.override);
        const row_count = header_row !== undefined
            ? Math.max(0, projection.physical.rowCount - 1)
            : projection.physical.rowCount;
        for (const row of requested) {
            if (!Number.isInteger(row) || row < 0 || row >= row_count) {
                throw new RangeError(`row index ${row} out of range (${row_count} rows)`);
            }
        }
        if (requested.length === 0) return { rows: [] };
        const physical_indices = header_row !== undefined
            ? requested.map((row) => row < header_row ? row : row + 1)
            : requested;
        return read_source_rows_indexed(this.base, sheet_index, physical_indices);
    }

    read_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        const projection = this.sheets[sheet_index];
        if (!projection) {
            throw new RangeError(
                `sheet index ${sheet_index} out of range (${this.sheets.length} sheets)`,
            );
        }
        const header_row = active_header_row(projection, projection.override);
        if (header_row === undefined) {
            return read_source_columns(
                this.base,
                sheet_index,
                start_row,
                count,
                column_indices,
            );
        }

        const row_count = Math.max(0, projection.physical.rowCount - 1);
        const start = Math.max(0, Math.min(start_row, row_count));
        const available = Math.min(Math.max(0, count), row_count - start);
        if (available <= 0) return { startRow: start, rows: [] };
        const before_count = start < header_row
            ? Math.min(available, header_row - start)
            : 0;
        const rows: (RenderedCell | null)[][] = [];
        if (before_count > 0) {
            rows.push(...read_source_columns(
                this.base,
                sheet_index,
                start,
                before_count,
                column_indices,
            ).rows.slice(0, before_count));
        }
        const after_count = available - before_count;
        if (after_count > 0) {
            const projected_start = start + before_count;
            rows.push(...read_source_columns(
                this.base,
                sheet_index,
                projected_start + 1,
                after_count,
                column_indices,
            ).rows.slice(0, after_count));
        }
        return { startRow: start, rows };
    }

    /** Predict one sheet's projected metadata without changing live row behavior. */
    plan_override(
        sheet_name: string,
        override: ExcelHeaderOverride | 'auto',
    ): ExcelHeaderOverridePlan | undefined {
        const sheet_index = this.sheets.findIndex(
            (entry) => entry.physical.name === sheet_name,
        );
        const projection = this.sheets[sheet_index];
        if (!projection) return undefined;
        const next_override = override === 'auto' ? undefined : override;
        return {
            sheetIndex: sheet_index,
            sheet: project_sheet(projection, next_override),
            previousMode: projection.override ?? 'auto',
            nextMode: override,
            previousActive: active_header_row(projection, projection.override) !== undefined,
            nextActive: active_header_row(projection, next_override) !== undefined,
        };
    }

    set_override(sheet_name: string, override: ExcelHeaderOverride | 'auto'): boolean {
        const sheet = this.sheets.find((entry) => entry.physical.name === sheet_name);
        if (!sheet) return false;
        sheet.override = override === 'auto' ? undefined : override;
        this._meta = this.build_meta();
        return true;
    }

    replace_overrides(overrides: Record<string, ExcelHeaderOverride> | undefined): void {
        const sanitized = sanitize_excel_header_overrides(overrides);
        for (const sheet of this.sheets) {
            sheet.override = override_for(sanitized, sheet.physical.name);
        }
        this._meta = this.build_meta();
    }

    /** Refresh manual header candidates after canonical hidden-row state changes. */
    replace_hidden_rows(
        hidden_rows: readonly (readonly number[] | undefined)[] | undefined,
    ): void {
        this.sheets.forEach((sheet, sheet_index) => {
            this.update_manual_candidate(sheet, sheet_index, hidden_rows?.[sheet_index]);
        });
        this._meta = this.build_meta();
    }

    set_hidden_rows(sheet_name: string, hidden_rows: readonly number[] | undefined): boolean {
        const sheet_index = this.sheets.findIndex((sheet) => sheet.physical.name === sheet_name);
        const sheet = this.sheets[sheet_index];
        if (!sheet) return false;
        this.update_manual_candidate(sheet, sheet_index, hidden_rows);
        this._meta = this.build_meta();
        return true;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.base.close();
    }

    private build_meta(): WorkbookMeta {
        return {
            hasFormatting: this.base.meta().hasFormatting,
            sheets: this.sheets.map((sheet) => project_sheet(sheet, sheet.override)),
        };
    }

    private update_manual_candidate(
        projection: SheetProjection,
        sheet_index: number,
        hidden_rows: readonly number[] | undefined,
        cached_first_row?: readonly (RenderedCell | null)[],
    ): void {
        const candidate = first_non_hidden_row(
            this.base,
            sheet_index,
            projection.physical.rowCount,
            hidden_rows ?? [],
        );
        projection.manualHeaderRow = candidate?.projectedRow;
        projection.manualHeaderSourceRow = candidate?.sourceRow;
        const row = candidate === undefined
            ? undefined
            : candidate.projectedRow === 0 && cached_first_row !== undefined
            ? cached_first_row
            : this.base.read_rows(sheet_index, candidate.projectedRow, 1).rows[0];
        projection.manualColumnNames = first_row_names(projection.physical, row);
    }
}

function override_for(
    overrides: Record<string, ExcelHeaderOverride>,
    sheet_name: string,
): ExcelHeaderOverride | undefined {
    return Object.prototype.hasOwnProperty.call(overrides, sheet_name)
        ? overrides[sheet_name]
        : undefined;
}

function active_header_row(
    sheet: SheetProjection,
    override: ExcelHeaderOverride | undefined,
): number | undefined {
    if (override === 'on') return sheet.manualHeaderRow;
    if (override === 'off' || !sheet.detected) return undefined;
    return 0;
}

function project_sheet(
    sheet: SheetProjection,
    override: ExcelHeaderOverride | undefined,
): SheetMeta {
    return project_excel_header_sheet({
        name: sheet.physical.name,
        rowCount: sheet.physical.rowCount,
        sourceRowCount: sheet.physical.sourceRowCount,
        columnCount: sheet.physical.columnCount,
        merges: sheet.physical.merges,
        hasFormatting: sheet.physical.hasFormatting,
        columnNames: sheet.firstRowColumnNames,
        manualColumnNames: sheet.manualColumnNames,
        manualHeaderRow: sheet.manualHeaderRow,
        manualHeaderSourceRow: sheet.manualHeaderSourceRow,
        detected: sheet.detected,
        override: sheet.override,
    }, override);
}

export function project_excel_header_sheet(
    sheet: ExcelHeaderPlanningSheet,
    override: ExcelHeaderOverride | undefined,
): SheetMeta {
    const has_manual_candidate = Object.prototype.hasOwnProperty.call(
        sheet,
        'manualHeaderRow',
    );
    const manual_header_row = has_manual_candidate
        ? sheet.manualHeaderRow
        : sheet.rowCount > 0 ? 0 : undefined;
    const manual_header_source_row = Object.prototype.hasOwnProperty.call(
        sheet,
        'manualHeaderSourceRow',
    ) ? sheet.manualHeaderSourceRow : manual_header_row;
    const header_row = override === 'on'
        ? manual_header_row
        : override === 'off' || !sheet.detected
        ? undefined
        : 0;
    const header_source_row = override === 'on'
        ? manual_header_source_row
        : header_row === 0 ? 0 : undefined;
    const active = header_row !== undefined;
    const column_names = override === 'on'
        ? sheet.manualColumnNames ?? sheet.columnNames
        : sheet.columnNames;
    return {
        name: sheet.name,
        rowCount: active ? Math.max(0, sheet.rowCount - 1) : sheet.rowCount,
        sourceRowCount: sheet.sourceRowCount,
        columnCount: sheet.columnCount,
        merges: active
            ? project_header_merges(sheet.merges, header_row)
            : sheet.merges.map((merge) => ({ ...merge })),
        hasFormatting: sheet.hasFormatting,
        columnNames: active ? [...column_names] : undefined,
        excelFirstRowHeader: {
            mode: override ?? 'auto',
            detected: sheet.detected,
            active,
            available: manual_header_row !== undefined && sheet.columnCount > 0,
            ...(active && override === 'on' && header_source_row !== undefined
                ? { sourceRow: header_source_row }
                : {}),
        },
    };
}

export function project_excel_header_workbook(
    input: ExcelHeaderPlanningInput,
    overrides: Record<string, ExcelHeaderOverride> | undefined,
): WorkbookMeta {
    return {
        hasFormatting: input.hasFormatting,
        sheets: input.sheets.map((sheet) => project_excel_header_sheet(
            sheet,
            overrides === undefined ? sheet.override : override_for(overrides, sheet.name),
        )),
    };
}

export function project_header_merges(
    merges: readonly MergeRange[],
    header_row = 0,
): MergeRange[] {
    const projected: MergeRange[] = [];
    for (const merge of merges) {
        if (merge.startRow === header_row) continue;
        if (merge.endRow < header_row) {
            projected.push({ ...merge });
            continue;
        }
        if (merge.startRow < header_row) {
            projected.push({ ...merge, endRow: merge.endRow - 1 });
            continue;
        }
        projected.push({
            ...merge,
            startRow: merge.startRow - 1,
            endRow: merge.endRow - 1,
        });
    }
    return projected;
}

function first_non_hidden_row(
    source: DataSource,
    sheet_index: number,
    row_count: number,
    hidden_rows: readonly number[],
): { projectedRow: number; sourceRow: number } | undefined {
    if (row_count === 0) return undefined;
    if (hidden_rows.length === 0) {
        return {
            projectedRow: 0,
            sourceRow: read_source_row_indices(source, sheet_index, [0])[0],
        };
    }
    // Controller ingress sanitizes this as sorted/unique. Keep candidate lookup
    // allocation-free even at the one-million-row persistence bound.
    let hidden_position = 0;
    let previous_source_row = -1;
    let mapping_is_monotonic = true;
    const chunk_size = 4096;
    for (let start = 0; start < row_count; start += chunk_size) {
        const count = Math.min(chunk_size, row_count - start);
        const projected = Uint32Array.from(
            { length: count },
            (_, offset) => start + offset,
        );
        const source_rows = read_source_row_indices(source, sheet_index, projected);
        for (let offset = 0; offset < source_rows.length; offset++) {
            const source_row = source_rows[offset];
            let is_hidden: boolean;
            if (mapping_is_monotonic && source_row >= previous_source_row) {
                while (
                    hidden_position < hidden_rows.length
                    && hidden_rows[hidden_position] < source_row
                ) hidden_position += 1;
                is_hidden = hidden_rows[hidden_position] === source_row;
            } else {
                mapping_is_monotonic = false;
                is_hidden = sorted_numeric_array_includes(hidden_rows, source_row);
            }
            previous_source_row = source_row;
            if (!is_hidden) {
                return {
                    projectedRow: start + offset,
                    sourceRow: source_row,
                };
            }
        }
    }
    return undefined;
}

function sorted_numeric_array_includes(values: readonly number[], target: number): boolean {
    let low = 0;
    let high = values.length - 1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        const value = values[middle];
        if (value === target) return true;
        if (value < target) low = middle + 1;
        else high = middle - 1;
    }
    return false;
}

function detection_structure_is_eligible(sheet: SheetMeta): boolean {
    return sheet.rowCount >= 2
        && sheet.columnCount >= 2
        && sheet.columnCount <= DETECTION_MAX_COLUMNS
        && !sheet.merges.some((merge) => merge.startRow === 0);
}

/** Conservative, bounded detector: ambiguous sheets deliberately remain data. */
export function detect_first_row_as_header(
    sheet: SheetMeta,
    sampled_rows: readonly (readonly (RenderedCell | null)[])[],
): boolean {
    if (
        !detection_structure_is_eligible(sheet)
        || sampled_rows.length < 2
    ) {
        return false;
    }

    const first = sampled_rows[0] ?? [];
    const normalized_names = new Set<string>();
    for (let column = 0; column < sheet.columnCount; column++) {
        const cell = first[column] ?? null;
        const text = header_text(cell);
        if (
            text.length === 0
            || text.length > HEADER_MAX_LENGTH
            || /[\r\n]/.test(text)
            || !cell_is_string(cell)
            || (cell !== null && cell_is_excel_date(cell))
        ) {
            return false;
        }
        const normalized = text.normalize('NFKC')
            .trim()
            .replace(/\s+/g, ' ')
            .toLocaleLowerCase();
        if (normalized_names.has(normalized)) return false;
        normalized_names.add(normalized);
    }

    let typed_body_evidence = false;
    let body_nonempty = 0;
    let body_bold = 0;
    let body_rows_with_data = 0;
    const columns_with_data = new Set<number>();
    for (const row of sampled_rows.slice(1)) {
        let row_has_data = false;
        for (let column = 0; column < sheet.columnCount; column++) {
            const cell = row[column] ?? null;
            if (cell_is_empty(cell)) continue;
            row_has_data = true;
            columns_with_data.add(column);
            body_nonempty++;
            if (cell?.bold) body_bold++;
            if (
                cell?.rawType === 'number'
                || cell?.rawType === 'boolean'
                || (cell !== null && cell_is_excel_date(cell))
            ) {
                typed_body_evidence = true;
            }
        }
        if (row_has_data) body_rows_with_data++;
    }

    if (columns_with_data.size !== sheet.columnCount) return false;
    if (typed_body_evidence) return true;

    const every_header_bold = Array.from(
        { length: sheet.columnCount },
        (_, column) => first[column]?.bold === true,
    ).every(Boolean);
    return every_header_bold
        && body_rows_with_data >= 2
        && body_nonempty > 0
        && body_bold / body_nonempty <= 0.25;
}

function first_row_names(
    sheet: SheetMeta,
    row: readonly (RenderedCell | null)[] | undefined,
): string[] {
    return Array.from({ length: sheet.columnCount }, (_, column) => (
        header_text(row?.[column] ?? null)
    ));
}

function header_text(cell: RenderedCell | null | undefined): string {
    if (!cell || cell.raw === null) return '';
    return cell.formatted.trim();
}

function cell_is_empty(cell: RenderedCell | null | undefined): boolean {
    return !cell || cell.raw === null || cell.raw === '';
}

function cell_is_string(cell: RenderedCell | null | undefined): boolean {
    return !cell_is_empty(cell)
        && (cell?.rawType === 'string' || cell?.rawType === undefined);
}

function cell_is_excel_date(cell: RenderedCell): boolean {
    if (cell.rawType === 'date') return true;
    if (cell.rawType !== 'string' || cell.raw === null) return false;
    return /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(cell.raw)
        && cell.formatted !== cell.raw;
}
