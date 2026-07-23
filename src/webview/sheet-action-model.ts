/** Actions the sheet-tab context menu can run against a sheet's grid. */
export type SheetAction = 'copy_sheet' | 'select_all';

export interface PendingSheetAction {
    sheet_index: number;
    action: SheetAction;
}

/**
 * Decide whether a pending sheet action is ready to run. A cross-sheet action
 * is deferred while the app switches sheets: it may only fire once the active
 * sheet is the target AND the currently mounted grid handle belongs to that same
 * sheet. The mounted-sheet check rejects a stale handle from the outgoing grid
 * during the keyed remount.
 */
export function pending_sheet_action_to_run(
    pending: PendingSheetAction | null,
    active_sheet_index: number,
    mounted_sheet_index: number | undefined,
): SheetAction | null {
    if (!pending) return null;
    if (pending.sheet_index !== active_sheet_index) return null;
    if (mounted_sheet_index !== active_sheet_index) return null;
    return pending.action;
}
