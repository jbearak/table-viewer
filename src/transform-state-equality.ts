/**
 * Whether two sets of view rules are the same, exactly as the host compares
 * them: filter ids and the schema count, and empty rules equal empty rules.
 * Shared by the host and the window so that provenance (plan I3) is decided by
 * one comparison on both sides.
 */

import type { SheetTransformState } from './types';

export function transform_states_equal(
    left: SheetTransformState,
    right: SheetTransformState,
): boolean {
    if (
        left.sort.length === 0
        && left.filters.length === 0
        && (left.hiddenRows?.length ?? 0) === 0
        && left.onlyChangedRows !== true
        && right.sort.length === 0
        && right.filters.length === 0
        && (right.hiddenRows?.length ?? 0) === 0
        && right.onlyChangedRows !== true
    ) return true;
    return left.schema === right.schema
        && (left.onlyChangedRows === true) === (right.onlyChangedRows === true)
        && left.sort.length === right.sort.length
        && left.sort.every((key, index) => (
            key.colIndex === right.sort[index].colIndex
            && key.direction === right.sort[index].direction
        ))
        && array_values_equal(left.hiddenRows, right.hiddenRows)
        && left.filters.length === right.filters.length
        && left.filters.every((entry, index) => {
            const candidate = right.filters[index];
            return entry.id === candidate.id
                && entry.colIndex === candidate.colIndex
                && entry.operator === candidate.operator
                && entry.value === candidate.value
                && entry.secondValue === candidate.secondValue
                && excluded_values_equal(entry.excludedValues, candidate.excludedValues)
                && entry.caseSensitive === candidate.caseSensitive
                && entry.enabled === candidate.enabled;
        });
}

function array_values_equal(
    left: readonly number[] | undefined,
    right: readonly number[] | undefined,
): boolean {
    if ((left?.length ?? 0) === 0 && (right?.length ?? 0) === 0) return true;
    return !!left && !!right
        && left.length === right.length
        && left.every((value, index) => value === right[index]);
}

function excluded_values_equal(
    left: readonly (string | null)[] | undefined,
    right: readonly (string | null)[] | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}
