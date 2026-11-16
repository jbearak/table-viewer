/**
 * A history entry as it reads under the current Header Row.
 *
 * An entry records what the user changed under identities a Header Row change
 * does not move: canonical source cells, Pending Row and Pending Column IDs.
 * Two things inside it are relative to where the body started when it was
 * made: a Worksheet Layout covers the body, and a Pending Column keys its
 * cells by whether their row is in the body. A Header Row change never
 * rewrites an entry. Replay asks this module for the entry re-expressed from
 * the body start it was made at (`HistoryEntry.bodyStarts`) to the current
 * one, through the same pure function that carries Pending Changes across a
 * Header Row change, so a re-expressed side and the store the host carried
 * agree.
 *
 * Some changes have no faithful form under another header. A value in the
 * Header Row is a column name, so a cell change made on an ordinary row cannot
 * be replayed while that row is the Header Row, or the reverse. A layout only
 * describes the body, so a row change naming rows that are now in or above
 * the header has no encoding. Such an entry is not replayable now, and the
 * answer says why; it is never dropped, and it replays again under a header
 * that leaves its rows where they were.
 */

import {
    HEADER_REBASE_CONFLICT_MESSAGE,
    rebase_pending_column_for_header,
    rebase_pending_edits_for_header,
    row_switched_header_role,
} from '../header-rebase';
import {
    own_pending_structural_changes,
    own_row_layout,
    own_structural_basis,
    type PendingColumn,
    type PendingStructuralChanges,
    type StructuralBasis,
} from '../pending-changes';
import { same_worksheet_target, worksheet_target_key, type WorksheetTarget } from '../types';
import type { RowLayout } from '../worksheet-layout';
import type {
    BasisTransition,
    HistoryChange,
    HistoryEntry,
    PendingEntryTransition,
} from './history-stack-model';

/** What replay needs to know about a worksheet as it is now. */
export interface HeaderSheet {
    /** The Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    readonly sourceRowCount: number;
}

/** Why an entry cannot be replayed under the current Header Row. */
export interface HeaderWait {
    /**
     * `header-cell`: a cell on a row that is the Header Row at one body start
     * and an ordinary row at the other. `rows`: a row change naming rows no
     * longer in the body. `notice`: the recorded layout carries a conflict, or
     * was authored at yet another body start.
     */
    readonly reason: 'header-cell' | 'rows' | 'notice';
    readonly worksheet: WorksheetTarget;
    /** The body start the entry was made at. */
    readonly from: number;
    /** The body start now. */
    readonly to: number;
    /** For `header-cell`: the source row of the cell that cannot be carried. */
    readonly row?: number;
}

export type EntryForHeader =
    | { readonly ok: true; readonly entry: HistoryEntry }
    | ({ readonly ok: false } & HeaderWait);

type Reason = HeaderWait['reason'];
interface Waits {
    readonly ok: false;
    readonly reason: Reason;
    readonly row?: number;
}
type Carried<T> = { readonly ok: true; readonly value: T } | Waits;

const carried = <T>(value: T): Carried<T> => ({ ok: true, value });
const waits = (reason: Reason, row?: number): Waits => ({
    ok: false,
    reason,
    ...(row === undefined ? {} : { row }),
});

/** The row of a Pending Column cell that sits on a row whose header role switched. */
function column_cell_on_switched_row(column: PendingColumn, move: Move): number | undefined {
    for (const key of Object.keys(column.cells)) {
        if (!key.startsWith('s:') && !key.startsWith('f:')) continue;
        const row = Number(key.slice(2));
        if (row_switched_header_role(row, move.from, move.to)) return row;
    }
    return undefined;
}

interface Move {
    readonly from: number;
    readonly to: number;
    readonly sourceRowCount: number;
}

/** A row layout and Structural Basis carried by the function that carries a live slot. */
function carry_layout(
    side: {
        readonly rowLayout?: RowLayout;
        readonly structuralBasis?: StructuralBasis;
        readonly tailRemovals?: PendingStructuralChanges['tailRemovals'];
        readonly conflicts?: PendingStructuralChanges['conflicts'];
    },
    move: Move,
): Carried<{ readonly rowLayout?: RowLayout; readonly structuralBasis?: StructuralBasis }> {
    const result = rebase_pending_edits_for_header({ cells: {}, ...side }, move);
    if (!result.ok) {
        return waits(result.message === HEADER_REBASE_CONFLICT_MESSAGE ? 'notice' : 'rows');
    }
    // Through the owning functions, so the shape is the one the store holds:
    // replay compares a side against the store as JSON.
    return carried({
        ...(result.slot.rowLayout === undefined ? {} : { rowLayout: own_row_layout(result.slot.rowLayout) }),
        ...(result.slot.structuralBasis === undefined
            ? {}
            : { structuralBasis: own_structural_basis(result.slot.structuralBasis) }),
    });
}

function carry_columns(
    columns: readonly PendingColumn[],
    move: Move,
): Carried<readonly PendingColumn[]> {
    const out: PendingColumn[] = [];
    for (const column of columns) {
        const moved = rebase_pending_column_for_header(column, move.from, move.to);
        if (moved === undefined) return waits('header-cell', column_cell_on_switched_row(column, move));
        out.push(moved);
    }
    return carried(out);
}

/** One whole-slot snapshot (a Discard, or an append's basis arm). */
function carry_snapshot(
    snapshot: PendingStructuralChanges,
    move: Move,
): Carried<PendingStructuralChanges> {
    const layout = carry_layout({
        ...(snapshot.rowLayout === undefined ? {} : { rowLayout: snapshot.rowLayout }),
        ...(snapshot.structuralBasis === undefined ? {} : { structuralBasis: snapshot.structuralBasis }),
        tailRemovals: snapshot.tailRemovals,
        conflicts: snapshot.conflicts,
    }, move);
    if (!layout.ok) return layout;
    const columns = carry_columns(snapshot.pendingColumns ?? [], move);
    if (!columns.ok) return columns;
    const { rowLayout: _rows, structuralBasis: _basis, pendingColumns: _columns, ...rest } = snapshot;
    return carried(own_pending_structural_changes({
        ...rest,
        ...layout.value,
        ...(snapshot.pendingColumns === undefined ? {} : { pendingColumns: columns.value }),
    }));
}

function carry_column_transitions(
    transitions: readonly PendingEntryTransition<PendingColumn>[],
    move: Move,
): Carried<readonly PendingEntryTransition<PendingColumn>[]> {
    const out: PendingEntryTransition<PendingColumn>[] = [];
    for (const transition of transitions) {
        const sides: (PendingColumn | null)[] = [];
        for (const side of [transition.before, transition.after]) {
            if (side === null) {
                sides.push(null);
                continue;
            }
            const moved = rebase_pending_column_for_header(side, move.from, move.to);
            if (moved === undefined) return waits('header-cell', column_cell_on_switched_row(side, move));
            sides.push(moved);
        }
        out.push({ id: transition.id, before: sides[0], after: sides[1] });
    }
    return carried(out);
}

function carry_change(change: HistoryChange, move: Move): Carried<HistoryChange> {
    // A view change names canonical source rows and columns, which a Header
    // Row change does not renumber.
    if (
        change.kind === 'highlight'
        || change.kind === 'rowAppend'
        || change.kind === 'view'
    ) return carried(change);
    if (change.kind === 'cell') {
        return row_switched_header_role(change.delta.sourceRow, move.from, move.to)
            ? waits('header-cell', change.delta.sourceRow)
            : carried(change);
    }
    if (change.kind === 'tailRemoval') {
        return [change.delta.before, change.delta.after]
            .some((removal) => removal !== null && removal.sourceRow < move.to)
            ? waits('rows')
            : carried(change);
    }
    if (change.kind === 'pendingRows') {
        const before = carry_snapshot(change.delta.before, move);
        if (!before.ok) return before;
        const after = carry_snapshot(change.delta.after, move);
        if (!after.ok) return after;
        return carried({
            kind: 'pendingRows',
            delta: { worksheet: change.delta.worksheet, before: before.value, after: after.value },
        });
    }
    // A layout arm. Each side's layout and Structural Basis move together, as
    // they do in a slot; a column layout holds no rows and stays as it is.
    const { delta } = change;
    const side = (which: 'before' | 'after') => carry_layout({
        ...(change.kind === 'rowLayout' && delta[which] !== null
            ? { rowLayout: delta[which] as RowLayout }
            : {}),
        ...(delta.structuralBasis?.[which] == null
            ? {}
            : { structuralBasis: delta.structuralBasis[which]! }),
    }, move);
    const before = side('before');
    if (!before.ok) return before;
    const after = side('after');
    if (!after.ok) return after;
    const columns = carry_column_transitions(delta.pendingColumns, move);
    if (!columns.ok) return columns;
    const basis: { structuralBasis?: BasisTransition<StructuralBasis> } = delta.structuralBasis === undefined
        ? {}
        : {
            structuralBasis: {
                before: before.value.structuralBasis ?? null,
                after: after.value.structuralBasis ?? null,
            },
        };
    if (change.kind === 'rowLayout') {
        return carried({
            kind: 'rowLayout',
            delta: {
                ...change.delta,
                before: change.delta.before === null ? null : before.value.rowLayout ?? null,
                after: change.delta.after === null ? null : after.value.rowLayout ?? null,
                pendingColumns: columns.value,
                ...basis,
            },
        });
    }
    return carried({
        kind: 'columnLayout',
        delta: { ...change.delta, pendingColumns: columns.value, ...basis },
    });
}

/**
 * `entry` re-expressed for where each worksheet's body starts now, or why it
 * cannot be replayed under the current Header Row.
 *
 * An entry none of whose worksheets moved is returned as it is. A worksheet
 * `sheet` cannot resolve is left alone: replay answers for that itself. The
 * re-expressed entry keeps the stored entry's identity, and is for building a
 * request only; history moves the stored entry.
 */
export function entry_for_current_header(
    entry: HistoryEntry,
    sheet: (worksheet: WorksheetTarget) => HeaderSheet | undefined,
): EntryForHeader {
    let changes: HistoryChange[] | undefined;
    const moves = new Map<string, Move | null>();
    // A gesture's changes come in runs on one worksheet, often thousands of
    // cells: the key is built once per run, not once per change.
    let last: WorksheetTarget | undefined;
    let move: Move | null = null;
    for (const [index, change] of entry.action.changes.entries()) {
        const { worksheet } = change.delta;
        if (last === undefined || !same_worksheet_target(last, worksheet)) {
            last = worksheet;
            const key = worksheet_target_key(worksheet);
            let known = moves.get(key);
            if (known === undefined) {
                const current = sheet(worksheet);
                const from = entry.bodyStarts?.[key] ?? 0;
                known = current === undefined || current.bodyStart === from
                    ? null
                    : { from, to: current.bodyStart, sourceRowCount: current.sourceRowCount };
                moves.set(key, known);
            }
            move = known;
        }
        if (move === null) continue;
        let result: Carried<HistoryChange>;
        try {
            result = carry_change(change, move);
        } catch {
            // A side the owning functions reject cannot be the store's.
            result = waits('rows');
        }
        if (!result.ok) {
            return {
                ok: false,
                reason: result.reason,
                worksheet,
                from: move.from,
                to: move.to,
                ...(result.row === undefined ? {} : { row: result.row }),
            };
        }
        if (result.value === change) continue;
        changes ??= [...entry.action.changes];
        changes[index] = result.value;
    }
    return changes === undefined
        ? { ok: true, entry }
        : { ok: true, entry: { ...entry, action: { label: entry.action.label, changes } } };
}
