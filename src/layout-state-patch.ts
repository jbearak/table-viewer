import { deep_clone_and_freeze } from './immutable';
import type { PerFileState, ScrollPosition } from './types';
import type { NormalizedPerFileState } from './viewer-snapshot';

export type LayoutValueChange<T> =
    | { readonly type: 'set'; readonly value: T }
    | { readonly type: 'delete' };

export interface LayoutSheetPatch<T> {
    readonly sheetIndex: number;
    readonly change: LayoutValueChange<T>;
}

/**
 * The layout leaves a `stateChanged` message may write.
 *
 * `columnWidths` is not among them. A width is written by `setColumnWidths`, which
 * names the columns and widths it means and is answered: a `stateChanged` carries
 * a whole state for the host to diff against the snapshot the window last
 * acknowledged, so it is refused whenever a delivery is in flight, and it has no
 * answer for undo history to record or move on. The window still holds the widths
 * (it draws columns from them, and deliveries carry them); it cannot write them
 * from here.
 *
 * `rowHeights` is deliberately not among them either, alongside `transforms`,
 * `columnVisibility` and `cellHighlights`: all four are host-owned, and a patch leaf is
 * exactly the mechanism by which a webview could overwrite one. For heights that is not
 * a hypothetical. Durable heights are keyed by canonical source row
 * (`PerFileState.rowHeights`) and the webview cannot map display→source for a
 * select-all resize, because those rows were never loaded — so the only map it could
 * ever offer here is display-keyed, which is the mis-keying the source-keyed design
 * exists to end. Removing the leaf makes that unreachable rather than merely discouraged;
 * the write path is `setRowHeights`, which the host maps and clamps.
 *
 * `NormalizedPerFileState` then goes one step further and omits the field outright, so
 * `basis` and `incoming` below have no `rowHeights` to disagree about in the first place.
 * The two defences are not redundant: the missing leaf is what stops a patch being
 * derived, and the missing field is what stops the webview holding the stale map a patch
 * would have been derived *from*.
 */
export interface LayoutStatePatch {
    readonly scrollPosition: readonly LayoutSheetPatch<ScrollPosition>[];
    /**
     * Per-sheet choice between formatted and raw cell values.
     *
     * A layout leaf, alongside `tabOrientation`: a view preference this panel owns
     * outright, derived from nothing the host computes and needing no mapping the
     * webview cannot do. That is what separates it from the host-owned four above —
     * they are absent because the webview cannot be trusted to key them, not merely
     * because they are large.
     */
    readonly showFormatting: readonly LayoutSheetPatch<boolean>[];
    readonly activeSheetIndex?: LayoutValueChange<number>;
    readonly tabOrientation?: LayoutValueChange<'horizontal' | 'vertical' | null>;
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

function derive_show_formatting_patches(
    basis: readonly (boolean | undefined)[],
    incoming: readonly (boolean | undefined)[],
): LayoutSheetPatch<boolean>[] {
    const patches: LayoutSheetPatch<boolean>[] = [];
    const sheet_count = Math.max(basis.length, incoming.length);
    for (let sheet_index = 0; sheet_index < sheet_count; sheet_index += 1) {
        const before = basis[sheet_index];
        const after = incoming[sheet_index];
        if (before === after) continue;
        patches.push(after === undefined
            ? { sheetIndex: sheet_index, change: { type: 'delete' } }
            : { sheetIndex: sheet_index, change: { type: 'set', value: after } });
    }
    return patches;
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
        scrollPosition: derive_scroll_patches(
            basis.scrollPosition,
            incoming.scrollPosition,
        ),
        showFormatting: derive_show_formatting_patches(
            basis.showFormatting ?? [],
            incoming.showFormatting ?? [],
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
    return patch.scrollPosition.length === 0
        && patch.showFormatting.length === 0
        && patch.activeSheetIndex === undefined
        && patch.tabOrientation === undefined;
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

function apply_show_formatting_patches(
    current: (boolean | undefined)[] | undefined,
    patches: readonly LayoutSheetPatch<boolean>[],
): (boolean | undefined)[] | undefined {
    let result = current;
    for (const patch of patches) {
        const existing = result?.[patch.sheetIndex];
        const next = patch.change.type === 'delete' ? undefined : patch.change.value;
        if (existing === next) continue;
        const cloned = [...(result ?? [])];
        cloned[patch.sheetIndex] = next;
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
    const scroll_position = apply_scroll_patches(
        current.scrollPosition,
        patch.scrollPosition,
    );
    if (scroll_position !== current.scrollPosition) {
        result = { ...result, scrollPosition: scroll_position };
    }
    const show_formatting = apply_show_formatting_patches(
        current.showFormatting,
        patch.showFormatting,
    );
    if (show_formatting !== current.showFormatting) {
        result = { ...result, showFormatting: show_formatting };
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
