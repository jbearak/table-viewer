import type { SheetMeta, WorkbookMeta } from './data-source/interface';
import {
    CELL_HIGHLIGHT_COLORS,
    transform_schema_for_sheet,
    type CellHighlightColor,
    type CellHighlightState,
    type SheetCellHighlightState,
} from './types';

export const MAX_HIGHLIGHTED_CELLS_PER_FILE = 100_000;

export interface CellHighlightPatch {
    readonly sheetIndex: number;
    /** A color sets a cell; null or undefined clears it. */
    readonly cells: Readonly<Record<string, CellHighlightColor | null | undefined>>;
}

export interface ParsedCellHighlightKey {
    readonly sourceRow: number;
    readonly sourceColumn: number;
}

const HIGHLIGHT_COLORS = new Set<CellHighlightColor>(CELL_HIGHLIGHT_COLORS);

export function sanitize_cell_highlight_color(
    value: unknown,
): CellHighlightColor | undefined {
    return typeof value === 'string'
        && HIGHLIGHT_COLORS.has(value as CellHighlightColor)
        ? value as CellHighlightColor
        : undefined;
}

export function parse_cell_highlight_key(
    key: unknown,
): ParsedCellHighlightKey | undefined {
    if (typeof key !== 'string' || !/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(key)) {
        return undefined;
    }
    const separator = key.indexOf(':');
    const source_row = Number(key.slice(0, separator));
    const source_column = Number(key.slice(separator + 1));
    if (!Number.isSafeInteger(source_row) || !Number.isSafeInteger(source_column)) {
        return undefined;
    }
    return { sourceRow: source_row, sourceColumn: source_column };
}

export function cell_highlight_key(
    source_row: number,
    source_column: number,
): string {
    if (
        !Number.isSafeInteger(source_row)
        || source_row < 0
        || !Number.isSafeInteger(source_column)
        || source_column < 0
    ) {
        throw new RangeError('Cell highlight coordinates must be non-negative safe integers.');
    }
    return `${source_row}:${source_column}`;
}

type SanitizedSheetHighlights =
    | { exceeded: true }
    | {
        exceeded: false;
        state: SheetCellHighlightState | undefined;
        count: number;
    };

function sanitize_sheet_cell_highlights_with_budget(
    value: unknown,
    sheet: SheetMeta,
    expected_schema: string,
    remaining_cells: number,
): SanitizedSheetHighlights {
    if (!is_record(value) || value.schema !== expected_schema || !is_record(value.cells)) {
        return { exceeded: false, state: undefined, count: 0 };
    }

    const entries: [ParsedCellHighlightKey, CellHighlightColor][] = [];
    for (const [key, candidate_color] of Object.entries(value.cells)) {
        const coordinates = parse_cell_highlight_key(key);
        const color = sanitize_cell_highlight_color(candidate_color);
        if (
            !coordinates
            || !color
            || coordinates.sourceRow >= sheet.sourceRowCount
            || coordinates.sourceColumn >= sheet.columnCount
        ) {
            continue;
        }
        if (entries.length >= remaining_cells) return { exceeded: true };
        entries.push([coordinates, color]);
    }
    entries.sort(([left], [right]) =>
        left.sourceRow - right.sourceRow
        || left.sourceColumn - right.sourceColumn);
    if (entries.length === 0) return { exceeded: false, state: undefined, count: 0 };

    const cells: Record<string, CellHighlightColor> = {};
    for (const [coordinates, color] of entries) {
        cells[cell_highlight_key(
            coordinates.sourceRow,
            coordinates.sourceColumn,
        )] = color;
    }
    return {
        exceeded: false,
        state: { schema: expected_schema, cells },
        count: entries.length,
    };
}

export function sanitize_sheet_cell_highlights(
    value: unknown,
    sheet: SheetMeta,
    expected_schema: string,
): SheetCellHighlightState | undefined {
    const result = sanitize_sheet_cell_highlights_with_budget(
        value,
        sheet,
        expected_schema,
        Number.MAX_SAFE_INTEGER,
    );
    return result.exceeded ? undefined : result.state;
}

export function sanitize_cell_highlight_state(
    value: unknown,
    meta: WorkbookMeta,
    expected_digest?: string,
): CellHighlightState | undefined {
    if (!is_record(value) || typeof value.sourceDigest !== 'string') {
        return undefined;
    }
    const digest = expected_digest ?? value.sourceDigest;
    if (value.sourceDigest !== digest || !Array.isArray(value.sheets)) {
        return undefined;
    }
    const stored_sheets = value.sheets;

    let remaining_cells = MAX_HIGHLIGHTED_CELLS_PER_FILE;
    let highlighted_cell_count = 0;
    const sheets: (SheetCellHighlightState | undefined)[] = [];
    for (const [index, sheet] of meta.sheets.entries()) {
        const result = sanitize_sheet_cell_highlights_with_budget(
            stored_sheets[index],
            sheet,
            transform_schema_for_sheet(sheet),
            remaining_cells,
        );
        if (result.exceeded) return undefined;
        sheets.push(result.state);
        highlighted_cell_count += result.count;
        remaining_cells -= result.count;
    }
    if (highlighted_cell_count === 0) return undefined;
    return { sourceDigest: digest, sheets };
}

export function apply_cell_highlight_patch(
    current: CellHighlightState | undefined,
    patch: CellHighlightPatch,
    meta: WorkbookMeta,
    digest: string,
): CellHighlightState | undefined {
    if (
        !Number.isSafeInteger(patch.sheetIndex)
        || patch.sheetIndex < 0
        || patch.sheetIndex >= meta.sheets.length
    ) {
        throw new RangeError('Cell highlight sheet index is outside the workbook.');
    }
    const sheet = meta.sheets[patch.sheetIndex];
    const schema = transform_schema_for_sheet(sheet);
    const sanitized_current = sanitize_cell_highlight_state(current, meta, digest);
    const existing_sheets = sanitized_current?.sheets.slice() ?? [];
    const existing_sheet = sanitized_current?.sheets[patch.sheetIndex];
    const cells = new Map<string, CellHighlightColor>(
        Object.entries(existing_sheet?.cells ?? {}),
    );

    if (is_record(patch.cells)) {
        for (const [key, candidate_color] of Object.entries(patch.cells)) {
            const coordinates = parse_cell_highlight_key(key);
            if (
                !coordinates
                || coordinates.sourceRow >= sheet.sourceRowCount
                || coordinates.sourceColumn >= sheet.columnCount
            ) {
                continue;
            }
            const canonical_key = cell_highlight_key(
                coordinates.sourceRow,
                coordinates.sourceColumn,
            );
            const color = sanitize_cell_highlight_color(candidate_color);
            if (color) cells.set(canonical_key, color);
            else if (candidate_color === null || candidate_color === undefined) {
                cells.delete(canonical_key);
            }
        }
    }

    const ordered_cells = ordered_cell_record(cells);
    existing_sheets[patch.sheetIndex] = Object.keys(ordered_cells).length > 0
        ? { schema, cells: ordered_cells }
        : undefined;
    while (
        existing_sheets.length > 0
        && existing_sheets[existing_sheets.length - 1] === undefined
    ) {
        existing_sheets.pop();
    }
    if (existing_sheets.every((entry) => entry === undefined)) return undefined;

    const result: CellHighlightState = {
        sourceDigest: digest,
        sheets: existing_sheets,
    };
    if (count_cell_highlights(result) > MAX_HIGHLIGHTED_CELLS_PER_FILE) {
        throw new RangeError(
            `A file may contain at most ${MAX_HIGHLIGHTED_CELLS_PER_FILE} highlighted cells.`,
        );
    }
    return result;
}

export function cell_highlight_states_equal(
    left: CellHighlightState | undefined,
    right: CellHighlightState | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.sourceDigest !== right.sourceDigest) return false;
    const sheet_count = Math.max(left.sheets.length, right.sheets.length);
    for (let index = 0; index < sheet_count; index++) {
        const left_sheet = left.sheets[index];
        const right_sheet = right.sheets[index];
        if (left_sheet === right_sheet) continue;
        if (!left_sheet || !right_sheet || left_sheet.schema !== right_sheet.schema) {
            return false;
        }
        const left_entries = Object.entries(left_sheet.cells);
        const right_entries = Object.entries(right_sheet.cells);
        if (left_entries.length !== right_entries.length) return false;
        const right_cells = right_sheet.cells;
        for (const [key, color] of left_entries) {
            if (right_cells[key] !== color) return false;
        }
    }
    return true;
}

export function reconcile_physical_cell_highlights(
    current: CellHighlightState | undefined,
    meta: WorkbookMeta,
    physical_digest: string,
    controlled_rebase_from_digest?: string,
): CellHighlightState | undefined {
    if (current?.sourceDigest === physical_digest) {
        return sanitize_cell_highlight_state(current, meta, physical_digest);
    }
    if (current?.sourceDigest === controlled_rebase_from_digest) {
        return rebase_cell_highlight_digest(current, physical_digest, meta);
    }
    return undefined;
}

export function rebase_cell_highlight_digest(
    current: CellHighlightState | undefined,
    next_digest: string,
    meta: WorkbookMeta,
): CellHighlightState | undefined {
    if (!current) return undefined;
    const sanitized = sanitize_cell_highlight_state(
        current,
        meta,
        current.sourceDigest,
    );
    return sanitized
        ? { ...sanitized, sourceDigest: next_digest }
        : undefined;
}

export function migrate_cell_highlight_schema(
    current: CellHighlightState | undefined,
    sheet_index: number,
    old_sheet: SheetMeta,
    new_sheet: SheetMeta,
): CellHighlightState | undefined {
    if (
        !current
        || !Number.isSafeInteger(sheet_index)
        || sheet_index < 0
        || old_sheet.name !== new_sheet.name
        || old_sheet.columnCount !== new_sheet.columnCount
    ) {
        return current;
    }
    const old_schema = transform_schema_for_sheet(old_sheet);
    const existing = sanitize_sheet_cell_highlights(
        current.sheets[sheet_index],
        old_sheet,
        old_schema,
    );
    if (!existing) return current;

    const next_schema = transform_schema_for_sheet(new_sheet);
    const migrated = sanitize_sheet_cell_highlights(
        { schema: next_schema, cells: existing.cells },
        new_sheet,
        next_schema,
    );
    const sheets = current.sheets.slice();
    sheets[sheet_index] = migrated;
    while (sheets.length > 0 && sheets[sheets.length - 1] === undefined) {
        sheets.pop();
    }
    return sheets.every((entry) => entry === undefined)
        ? undefined
        : { sourceDigest: current.sourceDigest, sheets };
}

export function count_cell_highlights(
    state: CellHighlightState | undefined,
): number {
    if (!state) return 0;
    return state.sheets.reduce(
        (count, sheet) => count + (sheet ? Object.keys(sheet.cells).length : 0),
        0,
    );
}

function ordered_cell_record(
    cells: ReadonlyMap<string, CellHighlightColor>,
): Record<string, CellHighlightColor> {
    const entries = [...cells.entries()]
        .map(([key, color]) => [parse_cell_highlight_key(key), color] as const)
        .filter((entry): entry is readonly [ParsedCellHighlightKey, CellHighlightColor] =>
            entry[0] !== undefined)
        .sort(([left], [right]) =>
            left.sourceRow - right.sourceRow
            || left.sourceColumn - right.sourceColumn);
    const result: Record<string, CellHighlightColor> = {};
    for (const [coordinates, color] of entries) {
        result[cell_highlight_key(
            coordinates.sourceRow,
            coordinates.sourceColumn,
        )] = color;
    }
    return result;
}

function is_record(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
