import type {
    ColumnWindow,
    DataSource,
    ExcelHeaderOverride,
    RenderedCell,
    RowWindow,
    SheetMeta,
    WorkbookMeta,
} from './interface';
import { read_source_columns } from './interface';
import type { MergeRange } from '../types';
import { sanitize_excel_header_overrides } from '../types';

const DETECTION_DATA_ROWS = 32;
const DETECTION_MAX_COLUMNS = 256;
const HEADER_MAX_LENGTH = 80;

interface SheetProjection {
    physical: SheetMeta;
    columnNames: string[];
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
    readonly columnCount: number;
    readonly merges: readonly Readonly<MergeRange>[];
    readonly hasFormatting: boolean;
    readonly columnNames: readonly string[];
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
            return {
                physical: sheet,
                columnNames: first_row_names(sheet, first_row),
                detected,
                override: override_for(sanitized, sheet.name),
            };
        });
        this._meta = this.build_meta();
    }

    get warnings(): string[] | undefined {
        return this.base.warnings;
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    /** Immutable facts used by pure state planning and CAS conflict retries. */
    planning_input(): ExcelHeaderPlanningInput {
        return Object.freeze({
            hasFormatting: this.base.meta().hasFormatting,
            sheets: Object.freeze(this.sheets.map((sheet) => Object.freeze({
                name: sheet.physical.name,
                rowCount: sheet.physical.rowCount,
                columnCount: sheet.physical.columnCount,
                merges: Object.freeze(
                    sheet.physical.merges.map((merge) => Object.freeze({ ...merge })),
                ),
                hasFormatting: sheet.physical.hasFormatting,
                columnNames: Object.freeze([...sheet.columnNames]),
                detected: sheet.detected,
                override: sheet.override,
            }))),
        });
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const projection = this.sheets[sheet_index];
        if (!projection) {
            throw new RangeError(
                `sheet index ${sheet_index} out of range (${this.sheets.length} sheets)`,
            );
        }
        if (!header_active(projection, projection.override)) {
            return this.base.read_rows(sheet_index, start_row, count);
        }

        const row_count = Math.max(0, projection.physical.rowCount - 1);
        const start = Math.max(0, Math.min(start_row, row_count));
        const requested = Math.max(0, count);
        const available = Math.min(requested, row_count - start);
        if (available <= 0) return { startRow: start, rows: [] };

        const physical = this.base.read_rows(
            sheet_index,
            start + 1,
            available,
        );
        return { startRow: start, rows: physical.rows.slice(0, available) };
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
        if (!header_active(projection, projection.override)) {
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
        const physical = read_source_columns(
            this.base,
            sheet_index,
            start + 1,
            available,
            column_indices,
        );
        return { startRow: start, rows: physical.rows.slice(0, available) };
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
            previousActive: header_active(projection, projection.override),
            nextActive: header_active(projection, next_override),
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
}

function override_for(
    overrides: Record<string, ExcelHeaderOverride>,
    sheet_name: string,
): ExcelHeaderOverride | undefined {
    return Object.prototype.hasOwnProperty.call(overrides, sheet_name)
        ? overrides[sheet_name]
        : undefined;
}

function header_active(
    sheet: SheetProjection,
    override: ExcelHeaderOverride | undefined,
): boolean {
    if (override === 'on') return true;
    if (override === 'off') return false;
    return sheet.detected;
}

function project_sheet(
    sheet: SheetProjection,
    override: ExcelHeaderOverride | undefined,
): SheetMeta {
    return project_excel_header_sheet({
        name: sheet.physical.name,
        rowCount: sheet.physical.rowCount,
        columnCount: sheet.physical.columnCount,
        merges: sheet.physical.merges,
        hasFormatting: sheet.physical.hasFormatting,
        columnNames: sheet.columnNames,
        detected: sheet.detected,
        override: sheet.override,
    }, override);
}

export function project_excel_header_sheet(
    sheet: ExcelHeaderPlanningSheet,
    override: ExcelHeaderOverride | undefined,
): SheetMeta {
    const active = override === 'on'
        ? true
        : override === 'off'
        ? false
        : sheet.detected;
    return {
        name: sheet.name,
        rowCount: active ? Math.max(0, sheet.rowCount - 1) : sheet.rowCount,
        columnCount: sheet.columnCount,
        merges: active
            ? project_header_merges(sheet.merges)
            : sheet.merges.map((merge) => ({ ...merge })),
        hasFormatting: sheet.hasFormatting,
        columnNames: active ? [...sheet.columnNames] : undefined,
        excelFirstRowHeader: {
            mode: override ?? 'auto',
            detected: sheet.detected,
            active,
            available: sheet.rowCount > 0 && sheet.columnCount > 0,
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

export function project_header_merges(merges: readonly MergeRange[]): MergeRange[] {
    const projected: MergeRange[] = [];
    for (const merge of merges) {
        if (merge.startRow === 0) continue;
        projected.push({
            ...merge,
            startRow: merge.startRow - 1,
            endRow: merge.endRow - 1,
        });
    }
    return projected;
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
