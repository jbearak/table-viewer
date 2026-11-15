// Carrying one worksheet's Pending Changes across a Header Row change.
//
// Cell changes are keyed by canonical source row, which a Header Row change
// does not move, so they need nothing. What does move is the body: a Worksheet
// Layout covers `[bodyStart, sourceRowCount)`, and an `.xlsx` Structural Basis
// records the `bodyStart` it was authored at. When the Header Row moves, the
// rows between the old and the new body start either join the body at its
// front (the header moved up or went away) or leave it (the header moved
// down). This module is the one place that decides whether that can happen
// without changing what Save would write, and produces the slot that says the
// same thing at the new body start.
//
// The host runs it inside the durable write that commits the header, so the
// header and the rebased slot are stored together; the webview runs the
// refusal half before it asks, so a refusal needs no round trip. It is a pure
// leaf: no imports from the webview or the host.
import type { PendingColumn, PendingStructuralChanges } from './pending-changes';
import {
    canonical_row_layout,
    moved_source_rows,
    type RowLayout,
} from './worksheet-layout';

/** The parts of a worksheet slot a header change can affect. */
export interface HeaderRebaseSlot {
    readonly cells: Readonly<Record<string, unknown>>;
    readonly tailRemovals?: PendingStructuralChanges['tailRemovals'];
    readonly appendBasis?: PendingStructuralChanges['appendBasis'];
    readonly conflicts?: PendingStructuralChanges['conflicts'];
    readonly rowLayout?: PendingStructuralChanges['rowLayout'];
    readonly columnLayout?: PendingStructuralChanges['columnLayout'];
    readonly pendingColumns?: PendingStructuralChanges['pendingColumns'];
    readonly structuralBasis?: PendingStructuralChanges['structuralBasis'];
}

export interface HeaderRebaseContext {
    /** The body start before the change: the Header Row's 1-based number, or 0. */
    readonly from: number;
    /** The body start after the change. */
    readonly to: number;
    /** Canonical source row count of the worksheet. */
    readonly sourceRowCount: number;
    /** Source rows hidden before the change. */
    readonly hiddenBefore?: readonly number[];
    /** Source rows hidden after the change. */
    readonly hiddenAfter?: readonly number[];
    /**
     * The append schema fingerprint of the worksheet under the new header. It
     * hashes the column names, which the header supplies; the columns
     * themselves do not change. Omitted by a caller that cannot compute it
     * (the webview's precheck), which leaves `appendBasis` as it is.
     */
    readonly appendSchemaFingerprint?: string;
}

export type HeaderRebaseResult<T extends HeaderRebaseSlot> =
    | { readonly ok: true; readonly slot: T }
    | { readonly ok: false; readonly message: string };

export const HEADER_REBASE_CONFLICT_MESSAGE =
    'Resolve the row and column changes notice before changing the header row.';
export const HEADER_REBASE_PENDING_COLUMN_MESSAGE =
    'Save or discard new columns before changing the header row.';
export const HEADER_REBASE_NEW_HEADER_CELL_MESSAGE =
    'Save first: the row that would become the header row has unsaved changes.';
export const HEADER_REBASE_OLD_HEADER_CELL_MESSAGE =
    'Save first: the header row has unsaved changes, and it would stop being the header row.';
export const HEADER_REBASE_HIDDEN_CELL_MESSAGE =
    'Save first: rows that would be hidden above the header row have unsaved changes.';
export const HEADER_REBASE_TRANSFORMED_MESSAGE =
    'Save or discard inserted and moved rows to choose this header row.';
export const HEADER_REBASE_PREFIX_MESSAGE =
    'Save or discard the row changes above this row to use it as the header row.';

function cell_row(key: string): number | undefined {
    const separator = key.indexOf(':');
    if (separator <= 0) return undefined;
    const row = Number(key.slice(0, separator));
    return Number.isSafeInteger(row) && row >= 0 ? row : undefined;
}

function live_pending_column_count(slot: HeaderRebaseSlot): number {
    const discarded = new Set(
        (slot.columnLayout?.discardedPendingColumns ?? []).map((column) => column.id),
    );
    return (slot.pendingColumns ?? []).filter((column) => !discarded.has(column.id)).length;
}

/** A live Pending Inserted Row, or a source row out of its order. */
function has_inserted_or_moved_rows(layout: RowLayout | undefined): boolean {
    if (layout === undefined) return false;
    const discarded = new Set(layout.discardedPendingRows.map((row) => row.id));
    const inserted = layout.runs.some((run) =>
        run.kind === 'pending' && run.ids.some((id) => !discarded.has(id)));
    return inserted || moved_source_rows(layout).length > 0;
}

function intersects(
    intervals: readonly { readonly start: number; readonly count: number }[],
    start: number,
    end: number,
): boolean {
    return intervals.some((interval) =>
        interval.start < end && interval.start + interval.count > start);
}

/**
 * Whether a header change from body start `from` to `to` can carry this slot,
 * and the slot that does. Returns the slot itself when nothing changes.
 *
 * Refused, with a message for the person:
 *  - a layout conflict is already recorded, or the layout was authored at
 *    another body start: the notice has to be resolved first;
 *  - a live Pending Column: its header text and its cells above the header
 *    would have to trade places;
 *  - any pending cell change on the old or the new Header Row. A header cell
 *    is saved as a column name (trimmed, forced to text, checked for blank and
 *    duplicate names) and a body cell is not, so no value means the same thing
 *    in both;
 *  - a pending cell change on a row the change newly hides, where it would be
 *    saved out of sight;
 *  - inserted or moved rows when rows are hidden afterwards: hidden rows turn
 *    off layout projection, the rule "Hide rows" already follows;
 *  - when the body start moves down, rows leaving the body that are not an
 *    untouched prefix of the layout.
 */
export function rebase_pending_edits_for_header<T extends HeaderRebaseSlot>(
    slot: T,
    context: HeaderRebaseContext,
): HeaderRebaseResult<T> {
    const { from, to, sourceRowCount } = context;
    if (from === to) return { ok: true, slot };
    if (
        !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
        || from < 0 || to < 0 || from > sourceRowCount || to > sourceRowCount
    ) {
        return { ok: false, message: 'The selected row is no longer available.' };
    }
    const refuse = (message: string): HeaderRebaseResult<T> => ({ ok: false, message });

    if ((slot.conflicts ?? []).some((conflict) =>
        conflict.reason === 'structuralBasisChanged' || conflict.reason === 'unsupportedStructure')) {
        return refuse(HEADER_REBASE_CONFLICT_MESSAGE);
    }
    const basis = slot.structuralBasis;
    if (basis?.kind === 'xlsx' && basis.bodyStart !== undefined && basis.bodyStart !== from) {
        return refuse(HEADER_REBASE_CONFLICT_MESSAGE);
    }
    if (live_pending_column_count(slot) > 0) return refuse(HEADER_REBASE_PENDING_COLUMN_MESSAGE);

    const old_header = from > 0 ? from - 1 : undefined;
    const new_header = to > 0 ? to - 1 : undefined;
    const hidden_before = new Set(context.hiddenBefore ?? []);
    const newly_hidden = new Set(
        (context.hiddenAfter ?? []).filter((row) => !hidden_before.has(row)),
    );
    for (const key of Object.keys(slot.cells)) {
        const row = cell_row(key);
        if (row === undefined) continue;
        if (row === new_header) return refuse(HEADER_REBASE_NEW_HEADER_CELL_MESSAGE);
        if (row === old_header) return refuse(HEADER_REBASE_OLD_HEADER_CELL_MESSAGE);
        if (newly_hidden.has(row)) return refuse(HEADER_REBASE_HIDDEN_CELL_MESSAGE);
    }

    const layout = slot.rowLayout;
    if ((context.hiddenAfter?.length ?? 0) > 0 && has_inserted_or_moved_rows(layout)) {
        return refuse(HEADER_REBASE_TRANSFORMED_MESSAGE);
    }

    let row_layout = layout;
    if (to > from) {
        // Rows [from, to) leave the body. They must be the layout's untouched
        // front: one source run from `from`, nothing before it, none removed.
        if ((slot.tailRemovals ?? []).some((removal) => removal.sourceRow < to)) {
            return refuse(HEADER_REBASE_PREFIX_MESSAGE);
        }
        if (layout !== undefined) {
            const first = layout.runs[0];
            if (
                first === undefined
                || first.kind !== 'source'
                || first.start !== from
                || first.count < to - from
                || intersects(layout.removedSourceRows, from, to)
            ) return refuse(HEADER_REBASE_PREFIX_MESSAGE);
            const remaining = first.count - (to - from);
            row_layout = canonical_row_layout({
                ...layout,
                runs: remaining > 0
                    ? [{ kind: 'source', start: to, count: remaining }, ...layout.runs.slice(1)]
                    : layout.runs.slice(1),
            });
        }
    } else if (layout !== undefined) {
        // Rows [to, from) join the body at its front, in file order.
        row_layout = canonical_row_layout({
            ...layout,
            runs: [{ kind: 'source', start: to, count: from - to }, ...layout.runs],
        });
    }

    const next = { ...slot } as Record<string, unknown>;
    if (row_layout !== undefined) next.rowLayout = row_layout;
    if (basis?.kind === 'xlsx') next.structuralBasis = Object.freeze({
        ...basis,
        ...(basis.bodyStart === undefined ? {} : { bodyStart: to }),
    });
    if (slot.appendBasis !== undefined && context.appendSchemaFingerprint !== undefined) {
        next.appendBasis = Object.freeze({
            ...slot.appendBasis,
            schemaFingerprint: context.appendSchemaFingerprint,
        });
    }
    return { ok: true, slot: Object.freeze(next) as unknown as T };
}

/**
 * The refusals that depend only on the slot, not on which row becomes the
 * header: what the webview can check before it asks. The host runs the full
 * rebase in the write that commits the header.
 */
export function header_rebase_slot_refusal(
    slot: HeaderRebaseSlot,
    current_body_start: number,
): string | undefined {
    if ((slot.conflicts ?? []).some((conflict) =>
        conflict.reason === 'structuralBasisChanged' || conflict.reason === 'unsupportedStructure')) {
        return HEADER_REBASE_CONFLICT_MESSAGE;
    }
    const basis = slot.structuralBasis;
    if (basis?.kind === 'xlsx' && basis.bodyStart !== undefined && basis.bodyStart !== current_body_start) {
        return HEADER_REBASE_CONFLICT_MESSAGE;
    }
    if (live_pending_column_count(slot) > 0) return HEADER_REBASE_PENDING_COLUMN_MESSAGE;
    return undefined;
}

/** Whether `row` is the Header Row at exactly one of the two body starts. */
export function row_switched_header_role(row: number, from: number, to: number): boolean {
    return (row === from - 1) !== (row === to - 1);
}

/**
 * A Pending Column as it reads once the body starts at `to`, or undefined when
 * it cannot be carried.
 *
 * A Pending Column keys its cells and highlights by row: `s:<row>` inside the
 * body, `f:<row>` above it, `p:<id>` on a Pending Row. Moving the body start
 * moves rows across that line, so each `s:`/`f:` key is rewritten for where its
 * row is now. `p:` keys and the header text do not depend on the body start:
 * Save writes the header text at whatever the Header Row is.
 *
 * A cell on a row that is the Header Row at one body start and not at the
 * other cannot be carried: there it would be a column name, here it is a cell.
 * A highlight has no such meaning and always moves.
 */
export function rebase_pending_column_for_header(
    column: PendingColumn,
    from: number,
    to: number,
): PendingColumn | undefined {
    if (from === to) return column;
    const rekey = <T>(
        entries: Readonly<Record<string, T>>,
        refuse_role_switch: boolean,
    ): Record<string, T> | undefined => {
        const out: Record<string, T> = {};
        for (const [key, value] of Object.entries(entries)) {
            const kind = key.slice(0, 2);
            const row = Number(key.slice(2));
            if ((kind !== 's:' && kind !== 'f:') || !Number.isSafeInteger(row) || row < 0) {
                out[key] = value;
                continue;
            }
            if (refuse_role_switch && row_switched_header_role(row, from, to)) return undefined;
            out[`${row < to ? 'f' : 's'}:${row}`] = value;
        }
        return out;
    };
    const cells = rekey(column.cells, true);
    if (cells === undefined) return undefined;
    const highlights = column.highlights === undefined ? undefined : rekey(column.highlights, false);
    return Object.freeze({
        ...column,
        cells: Object.freeze(cells),
        ...(highlights === undefined ? {} : { highlights: Object.freeze(highlights) }),
    });
}
