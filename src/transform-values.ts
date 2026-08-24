import {
    DEFERRED_FILTER_IDENTITY,
    type RawCell,
} from './data-source/interface';

export function raw_value(cell: RawCell | null | undefined): string | null {
    const raw = cell?.raw;
    // Whitespace-only cells are empty (not text) for both histogram and
    // sort/filter classification, matching common CSV export padding.
    return raw === null || raw === undefined || raw.trim().length === 0
        ? null
        : raw;
}

/** Return a known categorical identity without starting deferred work.
 * `undefined` means a deferred identity still needs to be resolved. */
export function peek_filter_value(
    cell: RawCell | null | undefined,
): string | null | undefined {
    const raw = raw_value(cell);
    if (raw === null) return null;
    const concrete = cell?.filterKey;
    if (concrete !== undefined) return concrete;
    const deferred = cell?.[DEFERRED_FILTER_IDENTITY];
    return deferred === undefined ? raw : deferred.cachedKey();
}

/** Exact categorical matching identity. Most values use their raw text; sources
 * with a bounded display preview may provide a separate lossless key. Throws for
 * an unresolved deferred identity so synchronous callers cannot match a preview. */
export function filter_value(cell: RawCell | null | undefined): string | null {
    const known = peek_filter_value(cell);
    if (known !== undefined) return known;
    throw new Error('Deferred filter identity must be resolved asynchronously.');
}

/** Resolve an exact categorical identity only for a caller that actually needs
 * it. Ordinary cells and completed deferred identities remain synchronous. */
export function resolve_filter_value(
    cell: RawCell | null | undefined,
    is_cancelled: () => boolean,
): string | null | Promise<string> {
    const known = peek_filter_value(cell);
    if (known !== undefined) return known;
    return cell![DEFERRED_FILTER_IDENTITY]!.resolveKey(is_cancelled);
}

export function stata_missing_rank(value: string): number | undefined {
    if (value.charCodeAt(0) !== 46) return undefined; // '.'
    if (value.length === 1) return 0;
    if (value.length !== 2) return undefined;
    const tag = value.charCodeAt(1) - 96;
    return tag >= 1 && tag <= 26 ? tag : undefined;
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
    cell: RawCell | null | undefined,
): boolean {
    const raw = raw_value(cell);
    if (raw === null || cell?.rawType === 'boolean' || cell?.rawType === 'date') {
        return false;
    }
    if (cell?.rawType === 'number') {
        return Number.isFinite(Number(raw)) || stata_missing_rank(raw) !== undefined;
    }
    // CSV marks every cell as string; still treat pure canonical number text
    // as numeric, matching acquire_transform_column.
    return canonical_numeric_string(raw);
}
