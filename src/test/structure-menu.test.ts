// The structure items every menu offers (src/webview/structure-menu.ts):
// Insert, Delete, Restore, and Move for rows and for columns, their labels,
// every reason they are disabled, and the gesture each enabled item runs.
// The cell, row, and column menus place these items; they don't decide them.
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingStructuralChanges,
    type RowIdentity,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import type { StructuralAxisSupport } from '../viewer-snapshot';
import {
    APPENDED_BAND_MESSAGE,
    LAST_LIVE_COLUMN_MESSAGE,
    MERGE_SPLIT_MESSAGE,
    merge_destination_message,
    STRUCTURE_CELL_MOVE_MESSAGE,
    STRUCTURE_TAIL_REMOVAL_MESSAGE,
    STRUCTURE_TRANSFORMED_MESSAGE,
    TOO_MANY_PENDING_ROWS_MESSAGE,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    FIXED_ROWS_MESSAGE,
    INSERT_ABOVE_HEADER_MESSAGE,
    INSERT_ONLY_REMOVED_ROWS_MESSAGE,
    MOVE_ABOVE_HEADER_MESSAGE,
    MOVE_AT_BOTTOM_MESSAGE,
    MOVE_AT_TOP_MESSAGE,
    MOVE_FIXED_ROWS_MESSAGE,
    MOVE_ONLY_REMOVED_ROWS_MESSAGE,
    plan_row_delete,
    RESTORE_ONLY_REMOVALS_MESSAGE,
    ROWS_NOT_LOADED_MESSAGE,
    row_structure_selection,
    SELECT_ADJACENT_ROWS_MESSAGE,
    STRUCTURE_BUSY_MESSAGE,
    type RowStructureSelection,
} from '../webview/row-structure-model';
import {
    INSERT_ONLY_REMOVED_COLUMNS_MESSAGE,
    MOVE_AT_LEFT_MESSAGE,
    MOVE_AT_RIGHT_MESSAGE,
    MOVE_ONLY_REMOVED_COLUMNS_MESSAGE,
    plan_column_delete,
    resolve_column_structure_selection,
    RESTORE_ONLY_REMOVED_COLUMNS_MESSAGE,
    SELECT_ADJACENT_COLUMNS_MESSAGE,
} from '../webview/column-structure-model';
import { create_layout_column_projection, type ProjectedColumn } from '../webview/column-projection';
import type { ActionMenuItem } from '../webview/context-menu';
import {
    structure_menu_items,
    type StructureGestures,
    type StructureMenuItems,
    type StructureMenuTarget,
} from '../webview/structure-menu';
import {
    TOO_MANY_ROW_RUNS_MESSAGE,
    TOO_WIDE_TO_RESTRUCTURE_MESSAGE,
    type ColumnIdentity,
    type RowLayout,
} from '../worksheet-layout';

const worksheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'data' };
const template = { id: 'plain', format: { kind: 'none' as const } };
const EMPTY: PendingStructuralChanges = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
const BASIS = { kind: 'delimited' as const, byteLength: 40, digest: 'abc', sourceRowCount: 10, sourceColumnCount: 4 };
const supported = { supported: true as const };
const tail_removal = {
    appendHistoryId: 'h', sourceRow: 9, savedFingerprint: 'f', savedRow: { cells: {}, format: { kind: 'none' as const } },
};

function context(overrides: Partial<WorksheetStructureContext> = {}): WorksheetStructureContext {
    return {
        worksheet,
        bodyStart: 0,
        sourceRowCount: 10,
        sourceColumnCount: 4,
        bodyViewTransformed: false,
        structuralBasis: BASIS,
        ...overrides,
    };
}

const source = (sourceRow: number): RowIdentity => ({ kind: 'source', sourceRow });
const pending = (pendingRowId: string): RowIdentity => ({ kind: 'pending', pendingRowId });
const src = (sourceColumn: number): ColumnIdentity => ({ kind: 'source', sourceColumn });
const rows = (count: number, start = 0): RowIdentity[] =>
    Array.from({ length: count }, (_, index) => source(start + index));

function appended(id: string, createdOrder: number): PendingAppendedRow {
    return { id, cells: {}, formatTemplateId: 'plain', createdOrder };
}

const band = (): PendingStructuralChanges =>
    ({ ...EMPTY, formatTemplates: [template], appendedRows: [appended('x', 1), appended('y', 2)] });

function deleted_rows(changes: PendingStructuralChanges, removed: number[]): PendingStructuralChanges {
    const plan = plan_row_delete(changes, context(), removed.map(source), new Map());
    if (!plan.ok) throw new Error(plan.message);
    return plan.outcome.next;
}

function deleted_columns(removed: number[]): PendingStructuralChanges {
    const plan = plan_column_delete(EMPTY, context(), removed.map(src), new Map());
    if (!plan.ok) throw new Error(plan.message);
    return plan.outcome.next;
}

function selection(overrides: Partial<RowStructureSelection>): RowStructureSelection {
    return row_structure_selection({
        count: 1,
        identities: [source(2)],
        removedSourceRows: [],
        fixedRows: false,
        tailRemovals: false,
        contiguous: true,
        bandRows: 0,
        endsAtBandEnd: false,
        ...overrides,
    } as Parameters<typeof row_structure_selection>[0]);
}

function columns_of(changes: PendingStructuralChanges, hidden: readonly number[] = []): readonly ProjectedColumn[] {
    return create_layout_column_projection(
        4,
        changes.columnLayout,
        hidden.length === 0 ? undefined : { hiddenColumns: hidden },
    ).columns;
}

function gestures(): { readonly [K in keyof StructureGestures]: Mock<StructureGestures[K]> } {
    return {
        insert_rows: vi.fn<StructureGestures['insert_rows']>(),
        append_rows: vi.fn<StructureGestures['append_rows']>(),
        delete_rows: vi.fn<StructureGestures['delete_rows']>(),
        restore_rows: vi.fn<StructureGestures['restore_rows']>(),
        move_rows: vi.fn<StructureGestures['move_rows']>(),
        insert_columns: vi.fn<StructureGestures['insert_columns']>(),
        delete_columns: vi.fn<StructureGestures['delete_columns']>(),
        restore_columns: vi.fn<StructureGestures['restore_columns']>(),
        move_columns: vi.fn<StructureGestures['move_columns']>(),
    };
}

interface Options {
    readonly ready?: boolean;
    readonly ctx?: WorksheetStructureContext;
    readonly support?: StructuralAxisSupport;
    readonly append_refusal?: string;
    readonly hidden?: readonly number[];
}

/** The items for a target, read as one menu, with the gestures they run. */
function open(target: StructureMenuTarget, changes: PendingStructuralChanges, options: Options = {}) {
    const calls = gestures();
    const axis_support = options.support ?? supported;
    const items: StructureMenuItems = structure_menu_items(target, {
        support: { rows: axis_support, columns: axis_support },
        ready: options.ready ?? true,
        changes,
        context: options.ctx ?? context(),
        columns: columns_of(changes, options.hidden),
        ...(options.append_refusal === undefined ? {} : { append_refusal: options.append_refusal }),
    }, calls);
    const all = [...items.insert, ...items.delete, ...items.move];
    const item = (label: string): ActionMenuItem => {
        const found = all.find((entry) => entry.label === label);
        if (found === undefined) throw new Error(`no item ${label} in ${all.map((entry) => entry.label).join(', ')}`);
        return found;
    };
    return {
        items,
        calls,
        labels: all.map((entry) => entry.label),
        /** The item's disabled reason, or undefined when it is enabled. */
        reason: (label: string) => (item(label).disabled ? item(label).disabled_reason ?? '(no reason)' : undefined),
        click: (label: string) => {
            const found = item(label);
            if (found.disabled) throw new Error(`${label} is disabled: ${found.disabled_reason}`);
            found.on_click({} as never);
        },
    };
}

function row_menu(changes: PendingStructuralChanges, overrides: Partial<RowStructureSelection> = {}, options: Options = {}) {
    return open({ axis: 'rows', selection: selection(overrides) }, changes, options);
}

function column_menu(changes: PendingStructuralChanges, display: readonly number[], options: Options = {}) {
    return open({
        axis: 'columns',
        selection: resolve_column_structure_selection(columns_of(changes, options.hidden), display),
    }, changes, options);
}

describe('labels', () => {
    it('names rows and columns by count, with a side for Insert and a direction for Move', () => {
        expect(row_menu(EMPTY).labels).toEqual([
            'Insert row above', 'Insert row below', 'Delete row', 'Move rows up', 'Move rows down',
        ]);
        expect(row_menu(EMPTY, { count: 3, identities: rows(3, 2) }).labels).toEqual([
            'Insert 3 rows above', 'Insert 3 rows below', 'Delete 3 rows', 'Move rows up', 'Move rows down',
        ]);
        expect(column_menu(EMPTY, [1]).labels).toEqual([
            'Insert column left', 'Insert column right', 'Delete column', 'Move columns left', 'Move columns right',
        ]);
        expect(column_menu(EMPTY, [1, 2]).labels).toEqual([
            'Insert 2 columns left', 'Insert 2 columns right', 'Delete 2 columns', 'Move columns left', 'Move columns right',
        ]);
    });

    it('offers Restore after Delete, counting only the deleted rows or columns', () => {
        const changes = deleted_rows(EMPTY, [2, 3]);
        const menu = row_menu(changes, { count: 3, identities: rows(3, 2), removedSourceRows: [2, 3] });
        expect(menu.items.delete.map((item) => item.label)).toEqual(['Delete 3 rows', 'Restore 2 rows']);
        expect(column_menu(deleted_columns([2]), [1, 2]).items.delete.map((item) => item.label))
            .toEqual(['Delete 2 columns', 'Restore column']);
    });
});

describe('readiness, the same on both axes', () => {
    it('disables every item with the busy reason while the grid is not ready', () => {
        for (const menu of [row_menu(EMPTY, {}, { ready: false }), column_menu(EMPTY, [1], { ready: false })]) {
            for (const label of menu.labels) expect(menu.reason(label), label).toBe(STRUCTURE_BUSY_MESSAGE);
        }
    });

    it('gives the host refusal for a worksheet it cannot restructure, in Move’s words for Move', () => {
        const support = (noun: string): StructuralAxisSupport => ({
            supported: false,
            reason: `Can't insert or delete ${noun} on this sheet: it contains an Excel table.`,
            moveReason: `Can't move ${noun} on this sheet: it contains an Excel table.`,
        });
        const rows_menu = row_menu(EMPTY, {}, { support: support('rows') });
        expect(rows_menu.reason('Insert row above'))
            .toBe("Can't insert or delete rows on this sheet: it contains an Excel table.");
        expect(rows_menu.reason('Delete row')).toBe("Can't insert or delete rows on this sheet: it contains an Excel table.");
        expect(rows_menu.reason('Move rows down')).toBe("Can't move rows on this sheet: it contains an Excel table.");
        const columns_menu = column_menu(EMPTY, [1], { support: support('columns') });
        expect(columns_menu.reason('Insert column right'))
            .toBe("Can't insert or delete columns on this sheet: it contains an Excel table.");
        expect(columns_menu.reason('Move columns left')).toBe("Can't move columns on this sheet: it contains an Excel table.");
        // A refusal without Move wording (too wide) reads the same on every item.
        const wide = column_menu(EMPTY, [1], { support: { supported: false, reason: TOO_WIDE_TO_RESTRUCTURE_MESSAGE } });
        for (const label of wide.labels) expect(wide.reason(label), label).toBe(TOO_WIDE_TO_RESTRUCTURE_MESSAGE);
    });
});

describe('row Delete and Restore', () => {
    it('deletes live rows by their runs, and offers no Restore without removals', () => {
        const menu = row_menu(EMPTY, { count: 2, identities: rows(2, 2) });
        expect(menu.items.delete).toHaveLength(1);
        menu.click('Delete 2 rows');
        expect(menu.calls.delete_rows).toHaveBeenCalledWith([{ kind: 'source', start: 2, count: 2 }]);
    });

    it('disables Delete for header rows, tail removals, unloaded rows, and the store’s refusals', () => {
        expect(row_menu(EMPTY, { fixedRows: true }).reason('Delete row')).toBe(FIXED_ROWS_MESSAGE);
        expect(row_menu(EMPTY, { tailRemovals: true }).reason('Delete row')).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
        expect(row_menu(EMPTY, { identities: undefined }).reason('Delete row')).toBe(ROWS_NOT_LOADED_MESSAGE);
        expect(row_menu(EMPTY, {}, { ctx: context({ hasPendingCellMove: () => true }) }).reason('Delete row'))
            .toBe(STRUCTURE_CELL_MOVE_MESSAGE);
    });

    it('enables Restore only for a selection made only of removals', () => {
        const changes = deleted_rows(EMPTY, [2, 3]);
        const only = row_menu(changes, { count: 2, identities: rows(2, 2), removedSourceRows: [2, 3] });
        // Every selected row is already deleted, so Delete has nothing to do.
        expect(only.reason('Delete 2 rows')).toBeDefined();
        only.click('Restore 2 rows');
        expect(only.calls.restore_rows).toHaveBeenCalledWith([{ start: 2, count: 2 }]);
        const mixed = row_menu(changes, { count: 2, identities: [source(2), source(5)], removedSourceRows: [2] });
        expect(mixed.reason('Delete 2 rows')).toBeUndefined();
        expect(mixed.reason('Restore row')).toBe(RESTORE_ONLY_REMOVALS_MESSAGE);
    });

    it('lets Delete remove Pending Appended Rows even beside a tail removal', () => {
        const changes = { ...band(), tailRemovals: [tail_removal] };
        expect(row_menu(changes, { identities: [pending('x')], bandRows: 1 }).reason('Delete row')).toBeUndefined();
    });
});

describe('row Insert', () => {
    it('inserts above and below contiguous body rows, anchored on the selection’s ends', () => {
        const menu = row_menu(EMPTY, { count: 3, identities: rows(3, 2) });
        menu.click('Insert 3 rows above');
        menu.click('Insert 3 rows below');
        expect(menu.calls.insert_rows.mock.calls).toEqual([[source(2), 'before', 3], [source(4), 'after', 3]]);
    });

    it('disables both with the reasons the gesture would give', () => {
        const reason = (overrides: Partial<RowStructureSelection>, options: Options = {}) =>
            row_menu(EMPTY, overrides, options).reason(overrides.count === 2 ? 'Insert 2 rows above' : 'Insert row above');
        expect(reason({ contiguous: false, count: 2, identities: [source(1), source(5)] }))
            .toBe(SELECT_ADJACENT_ROWS_MESSAGE);
        expect(reason({}, { ctx: context({ bodyViewTransformed: true }) })).toBe(STRUCTURE_TRANSFORMED_MESSAGE);
        expect(reason({ fixedRows: true })).toBe(INSERT_ABOVE_HEADER_MESSAGE);
        expect(reason({ tailRemovals: true })).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
        expect(reason({ identities: undefined })).toBe(ROWS_NOT_LOADED_MESSAGE);
        expect(reason({}, { ctx: context({ hasPendingCellMove: () => true }) })).toBe(STRUCTURE_CELL_MOVE_MESSAGE);
        // A selection of only deleted rows has nothing live to anchor on.
        expect(row_menu(deleted_rows(EMPTY, [2]), { removedSourceRows: [2] }).reason('Insert row below'))
            .toBe(INSERT_ONLY_REMOVED_ROWS_MESSAGE);
    });

    it('keeps the append band at the end: Insert below its last row appends', () => {
        const last = { identities: [pending('y')], bandRows: 1, endsAtBandEnd: true };
        const menu = row_menu(band(), last);
        expect(menu.reason('Insert row above')).toBe(APPENDED_BAND_MESSAGE);
        menu.click('Insert row below');
        expect(menu.calls.append_rows).toHaveBeenCalledWith(1);
        expect(menu.calls.insert_rows).not.toHaveBeenCalled();
        expect(row_menu(band(), last, { append_refusal: 'full' }).reason('Insert row below')).toBe('full');
        // Not the band's last row, or a selection spanning body and band.
        expect(row_menu(band(), { identities: [pending('x')], bandRows: 1 }).reason('Insert row below'))
            .toBe(APPENDED_BAND_MESSAGE);
        expect(row_menu(band(), { count: 2, identities: [source(9), pending('x')], bandRows: 1 })
            .reason('Insert 2 rows below')).toBe(APPENDED_BAND_MESSAGE);
    });

    it('refuses an over-limit selection before building any probe IDs', () => {
        // Larger than any array can be: allocating one probe ID per row would throw.
        const huge = 2 ** 32;
        const menu = row_menu(EMPTY, { count: huge, identities: [source(2), source(3)] });
        expect(menu.reason(`Insert ${huge} rows above`)).toBe(TOO_MANY_PENDING_ROWS_MESSAGE);
        expect(menu.reason(`Insert ${huge} rows below`)).toBe(TOO_MANY_PENDING_ROWS_MESSAGE);
    });
});

describe('row Move', () => {
    const both = (changes: PendingStructuralChanges, overrides: Partial<RowStructureSelection>, options: Options = {}) => {
        const menu = row_menu(changes, overrides, options);
        return [menu.reason('Move rows up'), menu.reason('Move rows down')];
    };
    const twice = (reason: string) => [reason, reason];

    it('moves the selected rows one step past a live neighbor', () => {
        const menu = row_menu(EMPTY, { count: 2, identities: rows(2, 4) });
        menu.click('Move rows up');
        menu.click('Move rows down');
        expect(menu.calls.move_rows.mock.calls).toEqual([[rows(2, 4), source(3)], [rows(2, 4), source(7)]]);
    });

    it('disables both with the shared reasons', () => {
        expect(both(EMPTY, { fixedRows: true })).toEqual(twice(MOVE_FIXED_ROWS_MESSAGE));
        expect(both(EMPTY, { tailRemovals: true })).toEqual(twice(STRUCTURE_TAIL_REMOVAL_MESSAGE));
        expect(both(EMPTY, { identities: undefined })).toEqual(twice(ROWS_NOT_LOADED_MESSAGE));
        expect(both(EMPTY, { count: 2, contiguous: false, identities: [source(1), source(5)] }))
            .toEqual(twice(SELECT_ADJACENT_ROWS_MESSAGE));
        expect(both(EMPTY, {}, { ctx: context({ bodyViewTransformed: true }) }))
            .toEqual(twice(STRUCTURE_TRANSFORMED_MESSAGE));
    });

    it('keeps appended rows at the end: a selection in or reaching into the band does not move', () => {
        expect(both(band(), { identities: [pending('x')], bandRows: 1 })).toEqual(twice(APPENDED_BAND_MESSAGE));
        expect(both(band(), { count: 2, identities: [source(9), pending('x')], bandRows: 1 }))
            .toEqual(twice(APPENDED_BAND_MESSAGE));
        // The last body row cannot move down into the band.
        expect(row_menu(band(), { identities: [source(9)] }).reason('Move rows down')).toBe(APPENDED_BAND_MESSAGE);
    });

    it('refuses a selection of only deleted rows', () => {
        expect(both(deleted_rows(EMPTY, [2, 3]), { count: 2, identities: rows(2, 2), removedSourceRows: [2, 3] }))
            .toEqual(twice(MOVE_ONLY_REMOVED_ROWS_MESSAGE));
    });

    it('stops at the Header Row and at the ends of the body', () => {
        expect(row_menu(EMPTY, { identities: [source(1)] }, { ctx: context({ bodyStart: 1 }) }).reason('Move rows up'))
            .toBe(MOVE_ABOVE_HEADER_MESSAGE);
        expect(row_menu(EMPTY, { identities: [source(0)] }).reason('Move rows up')).toBe(MOVE_AT_TOP_MESSAGE);
        expect(row_menu(EMPTY, { identities: [source(9)] }).reason('Move rows down')).toBe(MOVE_AT_BOTTOM_MESSAGE);
        // A deleted row at the top does not count as a row to pass.
        expect(row_menu(deleted_rows(EMPTY, [0]), { identities: [source(1)] }).reason('Move rows up'))
            .toBe(MOVE_AT_TOP_MESSAGE);
    });

    it('disables both under the cut-move and tail-removal exclusivity rules', () => {
        expect(both(EMPTY, {}, { ctx: context({ hasPendingCellMove: () => true }) }))
            .toEqual(twice(STRUCTURE_CELL_MOVE_MESSAGE));
        expect(both({ ...EMPTY, tailRemovals: [tail_removal] }, {})).toEqual(twice(STRUCTURE_TAIL_REMOVAL_MESSAGE));
    });

    it('refuses to split a merge or land inside one', () => {
        const merges = [{ startRow: 2, endRow: 3, startCol: 0, endCol: 1 }, { startRow: 6, endRow: 7, startCol: 0, endCol: 0 }];
        const ctx = context({ merges });
        expect(both(EMPTY, { identities: [source(2)] }, { ctx })).toEqual(twice(MERGE_SPLIT_MESSAGE));
        // Rows 4-5 passing row 6 would land between the merge's rows 6 and 7.
        expect(row_menu(EMPTY, { count: 2, identities: rows(2, 4) }, { ctx }).reason('Move rows down'))
            .toBe(merge_destination_message('rows'));
        // The whole merge moves as a unit.
        expect(row_menu(EMPTY, { count: 2, identities: rows(2, 2) }, { ctx }).reason('Move rows up')).toBeUndefined();
    });

    it('refuses a move past the row-run limit', () => {
        // 9,998 single-row runs in swapped pairs and one tail run: 9,999 runs.
        const runs: RowLayout['runs'][number][] = [];
        for (let row = 0; row < 9_998; row += 2) {
            runs.push({ kind: 'source', start: row + 1, count: 1 }, { kind: 'source', start: row, count: 1 });
        }
        runs.push({ kind: 'source', start: 9_998, count: 4 });
        const changes: PendingStructuralChanges = {
            ...EMPTY,
            rowLayout: { runs, removedSourceRows: [], discardedPendingRows: [] },
            structuralBasis: { ...BASIS, sourceRowCount: 10_002 },
        };
        const ctx = context({ sourceRowCount: 10_002, structuralBasis: { ...BASIS, sourceRowCount: 10_002 } });
        expect(row_menu(changes, { identities: [source(9_999)] }, { ctx }).reason('Move rows up'))
            .toBe(TOO_MANY_ROW_RUNS_MESSAGE);
    });
});

describe('column items', () => {
    it('inserts on both sides of a live column, deletes it, and moves it one displayed column', () => {
        const menu = column_menu(EMPTY, [1]);
        for (const label of menu.labels) menu.click(label);
        expect(menu.calls.insert_columns.mock.calls).toEqual([[src(1), 'before', 1], [src(1), 'after', 1]]);
        expect(menu.calls.delete_columns).toHaveBeenCalledWith([src(1)]);
        expect(menu.calls.move_columns.mock.calls).toEqual([[[src(1)], src(0)], [[src(1)], src(3)]]);
        expect(menu.items.delete).toHaveLength(1);
    });

    it('disables Insert and Move beside a tail removal', () => {
        const tail = own_pending_structural_changes({ ...EMPTY, tailRemovals: [{ ...tail_removal, sourceRow: 3 }] });
        expect(column_menu(tail, [1]).reason('Insert column left')).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
        expect(column_menu(tail, [1]).reason('Move columns right')).toBe(STRUCTURE_TAIL_REMOVAL_MESSAGE);
    });

    it('needs adjacent columns for Insert and Move, but deletes any selection', () => {
        const menu = column_menu(EMPTY, [0, 2]);
        expect(menu.reason('Insert 2 columns left')).toBe(SELECT_ADJACENT_COLUMNS_MESSAGE);
        expect(menu.reason('Move columns right')).toBe(SELECT_ADJACENT_COLUMNS_MESSAGE);
        expect(menu.reason('Delete 2 columns')).toBeUndefined();
    });

    it('keeps one live column', () => {
        expect(column_menu(EMPTY, [0, 1, 2, 3]).reason('Delete 4 columns')).toBe(LAST_LIVE_COLUMN_MESSAGE);
    });

    it('offers Restore for removals only, and anchors nothing on a removal alone', () => {
        const removed = deleted_columns([2]);
        const only = column_menu(removed, [2]);
        only.click('Restore column');
        expect(only.calls.restore_columns).toHaveBeenCalledWith([2]);
        expect(only.reason('Insert column left')).toBe(INSERT_ONLY_REMOVED_COLUMNS_MESSAGE);
        expect(only.reason('Move columns left')).toBe(MOVE_ONLY_REMOVED_COLUMNS_MESSAGE);
        expect(column_menu(removed, [1, 2]).reason('Restore column')).toBe(RESTORE_ONLY_REMOVED_COLUMNS_MESSAGE);
    });

    it('stops Move at the edges', () => {
        expect(column_menu(EMPTY, [0]).reason('Move columns left')).toBe(MOVE_AT_LEFT_MESSAGE);
        expect(column_menu(EMPTY, [3]).reason('Move columns right')).toBe(MOVE_AT_RIGHT_MESSAGE);
        const last_but_one = column_menu(EMPTY, [2]);
        last_but_one.click('Move columns right');
        expect(last_but_one.calls.move_columns).toHaveBeenCalledWith([src(2)], 'end');
    });

    it('steps past one displayed column, leaving hidden columns where they are', () => {
        // Column 1 is hidden: moving 2 (displayed second) left passes 0, not the hidden column.
        const menu = column_menu(EMPTY, [1], { hidden: [1] });
        menu.click('Move columns left');
        expect(menu.calls.move_columns).toHaveBeenCalledWith([src(2)], src(0));
    });
});
