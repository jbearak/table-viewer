import { migrate_cell_highlight_schema } from './cell-highlights';
import {
    project_excel_header_sheet,
    project_excel_header_workbook,
    type ExcelHeaderPlanningInput,
} from './data-source/excel-header-source';
import type { ExcelHeaderOverride, SheetMeta, WorkbookMeta } from './data-source/interface';
import type {
    PerFileState,
    SheetColumnVisibilityState,
    SheetTransformState,
    StoredPerFileState,
} from './types';
import {
    sanitize_excel_header_active,
    sanitize_excel_header_overrides,
    transform_schema_for_sheet,
} from './types';
import { normalize_complete_per_file_state } from './viewer-snapshot';

export interface ExcelCandidateStatePlan {
    state: PerFileState;
    changed: boolean;
    active: Record<string, boolean>;
    overrides: Record<string, ExcelHeaderOverride>;
    meta: WorkbookMeta;
}

export interface ExcelOverrideStatePlan {
    state: PerFileState;
    oldSheet: SheetMeta;
    newSheet: SheetMeta;
}

/** Pure legacy/current state normalization shared by every planning retry. */
export function normalize_host_state(
    stored: StoredPerFileState,
    sheet_names: string[],
): PerFileState {
    return normalize_complete_per_file_state(stored, sheet_names);
}

export function effective_excel_header_map(
    sheets: readonly SheetMeta[],
): Record<string, boolean> {
    const result = Object.create(null) as Record<string, boolean>;
    for (const sheet of sheets) {
        result[sheet.name] = sheet.excelFirstRowHeader?.active ?? false;
    }
    return result;
}

export function excel_header_maps_equal(
    left: Record<string, boolean>,
    right: Record<string, boolean>,
): boolean {
    const left_entries = Object.entries(left);
    return left_entries.length === Object.keys(right).length
        && left_entries.every(([name, active]) => (
            Object.prototype.hasOwnProperty.call(right, name)
            && right[name] === active
        ));
}

/**
 * Plan feature migration or a later detector change from immutable projection
 * facts. Conflict retries need only a new state snapshot; they never query the
 * candidate source or rerun detection.
 */
export function plan_excel_candidate_state(
    current: PerFileState,
    input: ExcelHeaderPlanningInput,
): ExcelCandidateStatePlan {
    const overrides = sanitize_excel_header_overrides(current.excelFirstRowHeaders);
    const meta = project_excel_header_workbook(input, overrides);
    const sheets = meta.sheets;
    const previous_active = sanitize_excel_header_active(
        current.excelFirstRowHeaderActive,
    );
    const next_active = effective_excel_header_map(sheets);
    const first_migration = current.excelFirstRowHeaderVersion !== 1;
    if (!first_migration && excel_header_maps_equal(previous_active, next_active)) {
        return {
            state: current,
            changed: false,
            active: next_active,
            overrides,
            meta,
        };
    }

    const rowHeights = [...(current.rowHeights ?? [])];
    const scrollPosition = [...(current.scrollPosition ?? [])];
    let transforms = current.transforms;
    let columnVisibility = current.columnVisibility;
    let cellHighlights = current.cellHighlights;

    sheets.forEach((sheet, index) => {
        const next_is_active = next_active[sheet.name] ?? false;
        const had_previous = Object.prototype.hasOwnProperty.call(
            previous_active,
            sheet.name,
        );
        const previous_is_active = first_migration
            ? false
            : had_previous
            ? previous_active[sheet.name]
            : false;
        const projection_changed = first_migration
            ? next_is_active
            : !had_previous
            ? next_is_active
            : previous_is_active !== next_is_active;
        if (!projection_changed) return;

        rowHeights[index] = undefined;
        scrollPosition[index] = undefined;
        const planning_sheet = input.sheets[index];
        if (!planning_sheet || planning_sheet.name !== sheet.name) return;
        const previous = project_excel_header_sheet(
            planning_sheet,
            previous_is_active ? 'on' : 'off',
        );
        transforms = migrate_compatible_sheet_schema(
            transforms,
            index,
            previous,
            sheet,
        );
        columnVisibility = migrate_compatible_sheet_schema(
            columnVisibility,
            index,
            previous,
            sheet,
        );
        cellHighlights = migrate_cell_highlight_schema(
            cellHighlights,
            index,
            previous,
            sheet,
        );
    });

    return {
        changed: true,
        active: next_active,
        overrides,
        meta,
        state: {
            ...current,
            rowHeights,
            scrollPosition,
            transforms,
            columnVisibility,
            cellHighlights,
            excelFirstRowHeaderActive: next_active,
            excelFirstRowHeaderVersion: 1,
        },
    };
}

/** Plan a durable explicit override solely from state plus immutable facts. */
export function plan_excel_override_state(
    current: PerFileState,
    input: ExcelHeaderPlanningInput,
    sheet_index: number,
    sheet_name: string,
    override: ExcelHeaderOverride,
): ExcelOverrideStatePlan | undefined {
    const planning_sheet = input.sheets[sheet_index];
    if (!planning_sheet || planning_sheet.name !== sheet_name) return undefined;
    const excelFirstRowHeaders = sanitize_excel_header_overrides(
        current.excelFirstRowHeaders,
    );
    const current_override = Object.prototype.hasOwnProperty.call(
        excelFirstRowHeaders,
        sheet_name,
    ) ? excelFirstRowHeaders[sheet_name] : undefined;
    const old_sheet = project_excel_header_sheet(planning_sheet, current_override);
    const new_sheet = project_excel_header_sheet(planning_sheet, override);
    excelFirstRowHeaders[sheet_name] = override;
    const excelFirstRowHeaderActive = sanitize_excel_header_active(
        current.excelFirstRowHeaderActive,
    );
    excelFirstRowHeaderActive[sheet_name] = (
        new_sheet.excelFirstRowHeader?.active ?? false
    );
    const rowHeights = [...(current.rowHeights ?? [])];
    const scrollPosition = [...(current.scrollPosition ?? [])];
    rowHeights[sheet_index] = undefined;
    scrollPosition[sheet_index] = undefined;

    return {
        oldSheet: old_sheet,
        newSheet: new_sheet,
        state: {
            ...current,
            excelFirstRowHeaders,
            excelFirstRowHeaderActive,
            excelFirstRowHeaderVersion: 1,
            rowHeights,
            scrollPosition,
            transforms: migrate_compatible_sheet_schema(
                current.transforms,
                sheet_index,
                old_sheet,
                new_sheet,
            ),
            columnVisibility: migrate_compatible_sheet_schema(
                current.columnVisibility,
                sheet_index,
                old_sheet,
                new_sheet,
            ),
            cellHighlights: migrate_cell_highlight_schema(
                current.cellHighlights,
                sheet_index,
                old_sheet,
                new_sheet,
            ),
        },
    };
}

function compatible_sheet(left: SheetMeta, right: SheetMeta): boolean {
    return left.name === right.name && left.columnCount === right.columnCount;
}

export function migrate_compatible_sheet_schema<T extends SheetTransformState | SheetColumnVisibilityState>(
    entries: (T | undefined)[] | undefined,
    sheet_index: number,
    old_sheet: SheetMeta,
    new_sheet: SheetMeta,
): (T | undefined)[] | undefined {
    if (!compatible_sheet(old_sheet, new_sheet)) return entries;
    const entry = entries?.[sheet_index];
    const old_schema = transform_schema_for_sheet(old_sheet);
    if (!entries || !entry || entry.schema !== old_schema) return entries;
    const next = [...entries];
    next[sheet_index] = {
        ...entry,
        schema: transform_schema_for_sheet(new_sheet),
    };
    return next;
}
