import { deep_clone_and_freeze } from './immutable';
import type { PerFileState, ScrollPosition } from './types';
import type { NormalizedPerFileState } from './viewer-snapshot';

export type LayoutValueChange<T> =
    | { readonly type: 'set'; readonly value: T }
    | { readonly type: 'delete' };

export interface LayoutNumericEntryPatch {
    readonly key: number;
    readonly change: LayoutValueChange<number>;
}

export interface LayoutNumericMapPatch {
    readonly sheetIndex: number;
    readonly entries: readonly LayoutNumericEntryPatch[];
}

export interface LayoutSheetPatch<T> {
    readonly sheetIndex: number;
    readonly change: LayoutValueChange<T>;
}

export interface LayoutStatePatch {
    readonly columnWidths: readonly LayoutNumericMapPatch[];
    readonly rowHeights: readonly LayoutNumericMapPatch[];
    readonly scrollPosition: readonly LayoutSheetPatch<ScrollPosition>[];
    readonly activeSheetIndex?: LayoutValueChange<number>;
    readonly tabOrientation?: LayoutValueChange<'horizontal' | 'vertical' | null>;
}

type NumericMap = Record<number, number>;

function canonical_numeric_keys(value: NumericMap | undefined): number[] {
    if (!value) return [];
    return Object.keys(value).flatMap((key) => {
        const numeric = Number(key);
        return Number.isSafeInteger(numeric)
            && numeric >= 0
            && String(numeric) === key
            ? [numeric]
            : [];
    }).sort((left, right) => left - right);
}

function derive_numeric_map_patches(
    basis: readonly (NumericMap | undefined)[],
    incoming: readonly (NumericMap | undefined)[],
): LayoutNumericMapPatch[] {
    const patches: LayoutNumericMapPatch[] = [];
    const sheet_count = Math.max(basis.length, incoming.length);
    for (let sheet_index = 0; sheet_index < sheet_count; sheet_index += 1) {
        const before = basis[sheet_index];
        const after = incoming[sheet_index];
        const keys = [...new Set([
            ...canonical_numeric_keys(before),
            ...canonical_numeric_keys(after),
        ])].sort((left, right) => left - right);
        const entries: LayoutNumericEntryPatch[] = [];
        for (const key of keys) {
            const before_has = before !== undefined
                && Object.prototype.hasOwnProperty.call(before, key);
            const after_has = after !== undefined
                && Object.prototype.hasOwnProperty.call(after, key);
            if (before_has === after_has && (!after_has || before![key] === after![key])) {
                continue;
            }
            entries.push(after_has
                ? { key, change: { type: 'set', value: after![key] } }
                : { key, change: { type: 'delete' } });
        }
        if (entries.length > 0) patches.push({ sheetIndex: sheet_index, entries });
    }
    return patches;
}

function scroll_positions_equal(
    left: ScrollPosition | undefined,
    right: ScrollPosition | undefined,
): boolean {
    return left === right || (
        left !== undefined
        && right !== undefined
        && left.top === right.top
        && left.left === right.left
    );
}

function derive_scroll_patches(
    basis: readonly (ScrollPosition | undefined)[],
    incoming: readonly (ScrollPosition | undefined)[],
): LayoutSheetPatch<ScrollPosition>[] {
    const patches: LayoutSheetPatch<ScrollPosition>[] = [];
    const sheet_count = Math.max(basis.length, incoming.length);
    for (let sheet_index = 0; sheet_index < sheet_count; sheet_index += 1) {
        const before = basis[sheet_index];
        const after = incoming[sheet_index];
        if (scroll_positions_equal(before, after)) continue;
        patches.push(after === undefined
            ? { sheetIndex: sheet_index, change: { type: 'delete' } }
            : {
                sheetIndex: sheet_index,
                change: { type: 'set', value: { top: after.top, left: after.left } },
            });
    }
    return patches;
}

/** Derive only layout leaves that changed in this panel's normalized state. */
export function derive_layout_state_patch(
    basis: Readonly<NormalizedPerFileState>,
    incoming: Readonly<NormalizedPerFileState>,
): Readonly<LayoutStatePatch> {
    const patch: LayoutStatePatch = {
        columnWidths: derive_numeric_map_patches(
            basis.columnWidths,
            incoming.columnWidths,
        ),
        rowHeights: derive_numeric_map_patches(
            basis.rowHeights,
            incoming.rowHeights,
        ),
        scrollPosition: derive_scroll_patches(
            basis.scrollPosition,
            incoming.scrollPosition,
        ),
        ...(basis.activeSheetIndex === incoming.activeSheetIndex
            ? {}
            : {
                activeSheetIndex: {
                    type: 'set' as const,
                    value: incoming.activeSheetIndex,
                },
            }),
        ...(basis.tabOrientation === incoming.tabOrientation
            ? {}
            : {
                tabOrientation: {
                    type: 'set' as const,
                    value: incoming.tabOrientation,
                },
            }),
    };
    return deep_clone_and_freeze(patch);
}

export function layout_state_patch_is_empty(
    patch: Readonly<LayoutStatePatch>,
): boolean {
    return patch.columnWidths.length === 0
        && patch.rowHeights.length === 0
        && patch.scrollPosition.length === 0
        && patch.activeSheetIndex === undefined
        && patch.tabOrientation === undefined;
}

function apply_numeric_map_patches(
    current: (NumericMap | undefined)[] | undefined,
    patches: readonly LayoutNumericMapPatch[],
): (NumericMap | undefined)[] | undefined {
    let result = current;
    for (const patch of patches) {
        const existing = result?.[patch.sheetIndex];
        let next_map = existing;
        for (const entry of patch.entries) {
            if (entry.change.type === 'delete') {
                if (
                    next_map === undefined
                    || !Object.prototype.hasOwnProperty.call(next_map, entry.key)
                ) continue;
                const cloned = { ...next_map };
                delete cloned[entry.key];
                next_map = Object.keys(cloned).length === 0 ? undefined : cloned;
            } else {
                if (
                    next_map !== undefined
                    && Object.prototype.hasOwnProperty.call(next_map, entry.key)
                    && next_map[entry.key] === entry.change.value
                ) continue;
                next_map = { ...(next_map ?? {}), [entry.key]: entry.change.value };
            }
        }
        if (next_map === existing) continue;
        const cloned = [...(result ?? [])];
        cloned[patch.sheetIndex] = next_map;
        result = cloned;
    }
    return result;
}

function apply_scroll_patches(
    current: (ScrollPosition | undefined)[] | undefined,
    patches: readonly LayoutSheetPatch<ScrollPosition>[],
): (ScrollPosition | undefined)[] | undefined {
    let result = current;
    for (const patch of patches) {
        const existing = result?.[patch.sheetIndex];
        const next = patch.change.type === 'delete'
            ? undefined
            : patch.change.value;
        if (scroll_positions_equal(existing, next)) continue;
        const cloned = [...(result ?? [])];
        cloned[patch.sheetIndex] = next === undefined
            ? undefined
            : { top: next.top, left: next.left };
        result = cloned;
    }
    return result;
}

/** Apply a fixed panel intent to the latest durable state without replacing peers' leaves. */
export function apply_layout_state_patch(
    current: Readonly<PerFileState>,
    patch: Readonly<LayoutStatePatch>,
): PerFileState {
    let result = current as PerFileState;
    const column_widths = apply_numeric_map_patches(
        current.columnWidths,
        patch.columnWidths,
    );
    if (column_widths !== current.columnWidths) {
        result = { ...result, columnWidths: column_widths };
    }
    const row_heights = apply_numeric_map_patches(
        current.rowHeights,
        patch.rowHeights,
    );
    if (row_heights !== current.rowHeights) {
        result = { ...result, rowHeights: row_heights };
    }
    const scroll_position = apply_scroll_patches(
        current.scrollPosition,
        patch.scrollPosition,
    );
    if (scroll_position !== current.scrollPosition) {
        result = { ...result, scrollPosition: scroll_position };
    }
    if (patch.activeSheetIndex !== undefined) {
        if (patch.activeSheetIndex.type === 'delete') {
            if ('activeSheetIndex' in result) {
                const { activeSheetIndex: _drop, ...rest } = result;
                result = rest;
            }
        } else if (result.activeSheetIndex !== patch.activeSheetIndex.value) {
            result = { ...result, activeSheetIndex: patch.activeSheetIndex.value };
        }
    }
    if (patch.tabOrientation !== undefined) {
        if (patch.tabOrientation.type === 'delete') {
            if ('tabOrientation' in result) {
                const { tabOrientation: _drop, ...rest } = result;
                result = rest;
            }
        } else if (result.tabOrientation !== patch.tabOrientation.value) {
            result = { ...result, tabOrientation: patch.tabOrientation.value };
        }
    }
    return result;
}
