import {
    DEFERRED_COMPARISON_IDENTITY,
    type DeferredCellIdentity,
    type RawCell,
} from './data-source/interface';
import type { CellData } from './types';

export function get_raw_cell_text(raw: CellData['raw']): string {
    return raw !== null ? String(raw) : '';
}

function comparison_identity(
    cell: RawCell | null | undefined,
): DeferredCellIdentity | undefined {
    return cell?.[DEFERRED_COMPARISON_IDENTITY];
}

function concrete_comparison_key(
    cell: RawCell | null | undefined,
): string | undefined {
    return cell?.comparisonKey ?? comparison_identity(cell)?.cachedKey();
}

function tagged_raw_text(cell: RawCell | null | undefined): string {
    return `raw:${get_raw_cell_text(cell?.raw ?? null)}`;
}

function tagged_comparison_key(key: string): string {
    return `comparison:${key}`;
}

export function get_cell_comparison_text(
    cell: RawCell | null | undefined,
): string {
    const comparison_key = concrete_comparison_key(cell);
    return comparison_key === undefined
        ? tagged_raw_text(cell)
        : tagged_comparison_key(comparison_key);
}

/** Materialize a lossless comparison identity only when the source has deferred
 * one. Ordinary cells and already-cached identities stay synchronous. */
export function materialize_cell_comparison_text(
    cell: RawCell | null | undefined,
    is_cancelled: () => boolean,
): string | Promise<string> {
    const comparison_key = concrete_comparison_key(cell);
    if (comparison_key !== undefined) return tagged_comparison_key(comparison_key);
    const deferred = comparison_identity(cell);
    if (deferred === undefined) return tagged_raw_text(cell);
    return deferred.resolveKey(is_cancelled).then(tagged_comparison_key);
}

/** Exact cell equality with synchronous fast paths for ordinary/materialized
 * values. Deferred sources may compare backing values directly without hashing. */
export function cells_exactly_equal(
    left: RawCell | null | undefined,
    right: RawCell | null | undefined,
    is_cancelled: () => boolean,
): boolean | Promise<boolean> {
    if (left === right) return true;
    const left_key = concrete_comparison_key(left);
    const right_key = concrete_comparison_key(right);
    if (left_key !== undefined && right_key !== undefined) return left_key === right_key;

    const left_deferred = comparison_identity(left);
    const right_deferred = comparison_identity(right);
    if (left_deferred !== undefined && right_deferred !== undefined) {
        const direct = left_deferred.exactlyEquals?.(right_deferred, is_cancelled)
            ?? right_deferred.exactlyEquals?.(left_deferred, is_cancelled);
        if (direct !== undefined) return direct;
    }

    // Comparison identities occupy a separate namespace from raw display text.
    // If only one side has one, no digest work can make the values equal.
    const left_has_identity = left_key !== undefined || left_deferred !== undefined;
    const right_has_identity = right_key !== undefined || right_deferred !== undefined;
    if (left_has_identity !== right_has_identity) return false;
    if (!left_has_identity) return tagged_raw_text(left) === tagged_raw_text(right);

    const left_text = left_key === undefined
        ? left_deferred!.resolveKey(is_cancelled)
        : left_key;
    const right_text = right_key === undefined
        ? right_deferred!.resolveKey(is_cancelled)
        : right_key;
    if (typeof left_text === 'string' && typeof right_text === 'string') {
        return left_text === right_text;
    }
    return Promise.all([left_text, right_text]).then(([resolved_left, resolved_right]) =>
        resolved_left === resolved_right);
}
