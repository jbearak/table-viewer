import type { PerFileState, SheetPendingEditCells, WorksheetPendingEdits } from '../types';

/**
 * Read one sheet's cell map back out of the worksheet-scoped leaf.
 *
 * The inverse of {@link sheet_edits}, for assertions: the tests below care what
 * a sheet holds, not how the slots are laid out, and `undefined` for an empty
 * slot reads the same as the flat map's `undefined` did.
 */
export function sheet_cells(
    pending: PerFileState['pendingEdits'],
    sheet_index = 0,
): SheetPendingEditCells | undefined {
    return pending?.[sheet_index]?.cells;
}

/**
 * Wrap one sheet's cell map in the worksheet-scoped `pendingEdits` leaf.
 *
 * Most of these tests predate worksheet editing and assert on CSV, which is
 * single-sheet — so they describe sheet 0 and this reads as the identity it used
 * to be. Tests that care about *which* sheet pass `sheet_index` explicitly.
 *
 * No `sheetName` is recorded by default, matching a legacy migrated slot: an
 * untagged slot is reattached by position, which is what these tests assume.
 */
export function sheet_edits(
    cells: SheetPendingEditCells,
    sheet_index = 0,
    sheet_name?: string,
): NonNullable<PerFileState['pendingEdits']> {
    const slots: (WorksheetPendingEdits | undefined)[] = [];
    for (let i = 0; i < sheet_index; i++) slots.push(undefined);
    slots.push(sheet_name === undefined ? { cells } : { sheetName: sheet_name, cells });
    return slots;
}
