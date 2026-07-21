import type { RenderedCell } from './data-source/interface';

export function raw_value(cell: RenderedCell | null | undefined): string | null {
    const raw = cell?.raw;
    // Whitespace-only cells are empty (not text) for both histogram and
    // sort/filter classification, matching common CSV export padding.
    return raw === null || raw === undefined || raw.trim().length === 0
        ? null
        : raw;
}

export function canonical_numeric_string(value: string): boolean {
    if (value.trim() !== value) return false;
    if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
        return false;
    }
    return Number.isFinite(Number(value));
}

/**
 * Align with transform column scanning (acquire_transform_column):
 * CSV cells are rawType:'string', but pure canonical number text is still numeric.
 * Dates are never numeric here; classify_value maps them to orderedText.
 */
export function cell_can_be_numeric(
    cell: RenderedCell | null | undefined,
): boolean {
    const raw = raw_value(cell);
    if (raw === null || cell?.rawType === 'boolean' || cell?.rawType === 'date') {
        return false;
    }
    if (cell?.rawType === 'number') return Number.isFinite(Number(raw));
    // CSV marks every cell as string; still treat pure canonical number text
    // as numeric, matching acquire_transform_column.
    return canonical_numeric_string(raw);
}
