import type {
    PerFileState,
    ScrollPosition,
    StoredPerFileState,
} from '../types';

export function clamp_sheet_index(
    sheet_index: number | undefined,
    sheet_count: number
): number {
    if (sheet_count === 0) return 0;
    if (
        sheet_index === undefined
        || !Number.isInteger(sheet_index)
        || sheet_index < 0
    ) {
        return 0;
    }
    return Math.min(sheet_index, sheet_count - 1);
}

export function normalize_per_file_state(
    state: StoredPerFileState,
    sheet_names: string[]
): PerFileState {
    const active_sheet_index = normalize_active_sheet_index(
        state,
        sheet_names
    );

    return {
        activeSheetIndex: active_sheet_index,
        columnWidths: normalize_sheet_state_array<Record<number, number>>(
            state.columnWidths,
            sheet_names
        ),
        rowHeights: normalize_sheet_state_array<Record<number, number>>(
            state.rowHeights,
            sheet_names
        ),
        scrollPosition: normalize_sheet_state_array<ScrollPosition>(
            state.scrollPosition,
            sheet_names
        ),
        tabOrientation: state.tabOrientation ?? null,
    };
}

export function trim_sheet_state_array<T>(
    value: (T | undefined)[] | undefined,
    sheet_count: number
): (T | undefined)[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, sheet_count);
}

function normalize_active_sheet_index(
    state: StoredPerFileState,
    sheet_names: string[]
): number {
    if ('activeSheetIndex' in state) {
        return clamp_sheet_index(state.activeSheetIndex, sheet_names.length);
    }

    if ('activeSheet' in state && typeof state.activeSheet === 'string') {
        const legacy_index = sheet_names.indexOf(state.activeSheet);
        return clamp_sheet_index(
            legacy_index === -1 ? undefined : legacy_index,
            sheet_names.length
        );
    }

    return 0;
}

function normalize_sheet_state_array<T>(
    value: ((T | undefined)[] | Record<string, T>) | undefined,
    sheet_names: string[]
): (T | undefined)[] {
    if (Array.isArray(value)) {
        return value.slice(0, sheet_names.length);
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    const result = new Array<T | undefined>(sheet_names.length);
    for (const [index, name] of sheet_names.entries()) {
        if (Object.prototype.hasOwnProperty.call(value, name)) {
            result[index] = value[name];
        }
    }
    return result;
}
