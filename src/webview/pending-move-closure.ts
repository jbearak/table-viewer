/** Cross-store cut/move closure for source edits and pending appended-row cells. */

import { cell_key, parse_cell_key } from '../cell-key';
import type {
    PendingRowCell,
    PendingStructuralChanges,
    RowIdentity,
} from '../pending-changes';
import type { CsvDirtyEntry } from '../types';

export interface MoveCellAddress {
    readonly rowIdentity: RowIdentity;
    readonly sourceColumn: number;
}

export interface PendingMoveDiscardPlan {
    readonly sourceKeys: ReadonlySet<string>;
    readonly pendingCells: readonly {
        readonly pendingRowId: string;
        readonly sourceColumn: number;
    }[];
    readonly cells: readonly MoveCellAddress[];
    readonly count: number;
}

function identity_key(identity: RowIdentity, source_column: number): string {
    return identity.kind === 'source'
        ? `source:${identity.sourceRow}:${source_column}`
        : `pending:${identity.pendingRowId}:${source_column}`;
}

function source_identity(source_row: number): RowIdentity {
    return { kind: 'source', sourceRow: source_row };
}

/** Plan every extant cell connected to the selected cut/move component. */
export function plan_pending_move_discard(
    source_entries: Iterable<readonly [string, CsvDirtyEntry]>,
    pending: PendingStructuralChanges,
    selected: readonly MoveCellAddress[],
): PendingMoveDiscardPlan {
    const extant = new Map<string, MoveCellAddress>();
    const source_key_by_node = new Map<string, string>();
    const pending_cell_by_node = new Map<string, {
        readonly pendingRowId: string;
        readonly sourceColumn: number;
    }>();
    const orders_by_node = new Map<string, Set<number>>();
    const nodes_by_order = new Map<number, Set<string>>();
    const add_move = (
        source: MoveCellAddress,
        destination: MoveCellAddress,
        order: number,
    ): void => {
        const nodes = [
            identity_key(source.rowIdentity, source.sourceColumn),
            identity_key(destination.rowIdentity, destination.sourceColumn),
        ];
        for (const node of nodes) {
            const orders = orders_by_node.get(node) ?? new Set<number>();
            orders.add(order);
            orders_by_node.set(node, orders);
        }
        const related = nodes_by_order.get(order) ?? new Set<string>();
        nodes.forEach((node) => related.add(node));
        nodes_by_order.set(order, related);
    };
    const index_provenance = (
        destination: MoveCellAddress,
        cell: Pick<PendingRowCell, 'movedFrom'> | Pick<CsvDirtyEntry, 'movedFrom'>,
    ): void => {
        const moved = cell.movedFrom;
        if (moved === undefined) return;
        add_move({
            rowIdentity: moved.rowIdentity ?? source_identity(moved.row),
            sourceColumn: moved.col,
        }, destination, moved.order);
        for (const previous of moved.previous ?? []) {
            add_move({
                rowIdentity: previous.sourceRowIdentity
                    ?? source_identity(previous.sourceRow),
                sourceColumn: previous.sourceCol,
            }, {
                rowIdentity: previous.destinationRowIdentity
                    ?? source_identity(previous.destinationRow),
                sourceColumn: previous.destinationCol,
            }, previous.order);
        }
    };

    for (const [key, entry] of source_entries) {
        const parsed = parse_cell_key(key);
        if (parsed === undefined) continue;
        const address = {
            rowIdentity: source_identity(parsed.sourceRow),
            sourceColumn: parsed.sourceColumn,
        };
        const node = identity_key(address.rowIdentity, address.sourceColumn);
        extant.set(node, address);
        source_key_by_node.set(node, key);
        index_provenance(address, entry);
    }
    for (const row of pending.appendedRows) {
        for (const [column_text, cell] of Object.entries(row.cells)) {
            const source_column = Number(column_text);
            const address = {
                rowIdentity: { kind: 'pending' as const, pendingRowId: row.id },
                sourceColumn: source_column,
            };
            const node = identity_key(address.rowIdentity, source_column);
            extant.set(node, address);
            pending_cell_by_node.set(node, {
                pendingRowId: row.id,
                sourceColumn: source_column,
            });
            index_provenance(address, cell);
        }
    }

    const closure = new Set(selected.map((cell) =>
        identity_key(cell.rowIdentity, cell.sourceColumn)));
    const pending_nodes = [...closure];
    const visited_orders = new Set<number>();
    while (pending_nodes.length > 0) {
        const node = pending_nodes.pop();
        if (node === undefined) break;
        for (const order of orders_by_node.get(node) ?? []) {
            if (visited_orders.has(order)) continue;
            visited_orders.add(order);
            for (const related of nodes_by_order.get(order) ?? []) {
                if (closure.has(related)) continue;
                closure.add(related);
                pending_nodes.push(related);
            }
        }
    }
    const nodes = [...closure].filter((node) => extant.has(node));
    const sourceKeys = new Set(nodes.flatMap((node) => {
        const key = source_key_by_node.get(node);
        return key === undefined ? [] : [key];
    }));
    const pendingCells = nodes.flatMap((node) => {
        const cell = pending_cell_by_node.get(node);
        return cell === undefined ? [] : [cell];
    });
    const cells = nodes.map((node) => extant.get(node)!);
    return { sourceKeys, pendingCells, cells, count: nodes.length };
}

/** Remove planned pending cells and every formula conflict they resolve. */
export function pending_changes_after_move_discard(
    before: PendingStructuralChanges,
    plan: PendingMoveDiscardPlan,
): PendingStructuralChanges {
    const columns_by_row = new Map<string, Set<number>>();
    for (const cell of plan.pendingCells) {
        const columns = columns_by_row.get(cell.pendingRowId) ?? new Set<number>();
        columns.add(cell.sourceColumn);
        columns_by_row.set(cell.pendingRowId, columns);
    }
    const appendedRows = before.appendedRows.map((row) => {
        const columns = columns_by_row.get(row.id);
        if (columns === undefined) return row;
        const cells = { ...row.cells };
        columns.forEach((column) => delete cells[column]);
        return { ...row, cells };
    });
    const removed = new Set(plan.cells.map((cell) =>
        identity_key(cell.rowIdentity, cell.sourceColumn)));
    const conflicts = before.conflicts.flatMap((conflict) => {
        if (conflict.reason !== 'ambiguousPendingFormula'
            || conflict.formulaCells === undefined) return [conflict];
        const formulaCells = conflict.formulaCells.filter((cell) => !removed.has(
            identity_key(cell.rowIdentity, cell.sourceColumn),
        ));
        if (formulaCells.length === conflict.formulaCells.length) return [conflict];
        const pendingRowIds = conflict.pendingRowIds.filter((pending_row_id) =>
            formulaCells.some((cell) => cell.rowIdentity.kind === 'pending'
                && cell.rowIdentity.pendingRowId === pending_row_id));
        if (
            formulaCells.length === 0
            && pendingRowIds.length === 0
            && conflict.tailRemovalIds.length === 0
        ) return [];
        return [{ ...conflict, formulaCells, pendingRowIds }];
    });
    return { ...before, appendedRows, conflicts };
}

/** Convert a source row identity to its edit-store key. */
export function source_key_for_move_cell(cell: MoveCellAddress): string | undefined {
    return cell.rowIdentity.kind === 'source'
        ? cell_key(cell.rowIdentity.sourceRow, cell.sourceColumn)
        : undefined;
}
