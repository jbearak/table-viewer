import { describe, expect, it } from 'vitest';
import {
    HEADER_REBASE_CONFLICT_MESSAGE,
    HEADER_REBASE_HIDDEN_CELL_MESSAGE,
    HEADER_REBASE_NEW_HEADER_CELL_MESSAGE,
    HEADER_REBASE_OLD_HEADER_CELL_MESSAGE,
    HEADER_REBASE_PENDING_COLUMN_MESSAGE,
    HEADER_REBASE_PREFIX_MESSAGE,
    HEADER_REBASE_TRANSFORMED_MESSAGE,
    header_rebase_slot_refusal,
    rebase_pending_edits_for_header,
    type HeaderRebaseSlot,
} from '../header-rebase';
import { pending_structure_error, type PendingStructuralChanges } from '../pending-changes';
import {
    delete_rows,
    insert_rows,
    move_rows,
    source_row_layout,
    type RowLayout,
} from '../worksheet-layout';

const ROWS = 10;

function xlsx_basis(body_start: number): NonNullable<PendingStructuralChanges['structuralBasis']> {
    return {
        kind: 'xlsx',
        worksheetPartDigest: 'part',
        sharedStringsDigest: null,
        stylesDigest: null,
        workbookDigest: 'book',
        sourceRowCount: ROWS,
        sourceColumnCount: 2,
        bodyStart: body_start,
    };
}

function layout_ok<L>(result: { ok: true; layout: L } | { ok: false }): L {
    if (!result.ok) throw new Error('layout operation refused');
    return result.layout;
}

/** A body that starts at `body_start` with source row `removed` deleted. */
function deleted(body_start: number, removed: number): RowLayout {
    return layout_ok(delete_rows(
        source_row_layout(body_start, ROWS - body_start),
        [{ kind: 'source', sourceRow: removed }],
        () => 0,
    ));
}

function slot(fields: Partial<HeaderRebaseSlot> = {}): HeaderRebaseSlot {
    return { cells: {}, ...fields };
}

function assert_valid_at(result: ReturnType<typeof rebase_pending_edits_for_header>, body_start: number) {
    if (!result.ok) throw new Error(result.message);
    const { cells, ...structural } = result.slot;
    expect(pending_structure_error(
        {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
            ...structural,
        } as PendingStructuralChanges,
        cells as Record<string, unknown>,
        { bodyStart: body_start, sourceRowCount: ROWS, sourceColumnCount: 2 },
    )).toBeUndefined();
    return result.slot;
}

describe('rebase_pending_edits_for_header', () => {
    it('returns the slot itself when the body start does not move', () => {
        const given = slot({ cells: { '0:0': 'x' } });
        const result = rebase_pending_edits_for_header(given, { from: 1, to: 1, sourceRowCount: ROWS });
        expect(result).toEqual({ ok: true, slot: given });
        expect(result.ok && result.slot).toBe(given);
    });

    it('leaves cell changes keyed by source row as they are', () => {
        const cells = { '4:1': { value: 'pear', base: 'apple' } };
        const result = rebase_pending_edits_for_header(slot({ cells }), {
            from: 1, to: 0, sourceRowCount: ROWS,
        });
        expect(result.ok && result.slot.cells).toBe(cells);
    });

    it('puts the rows above the old body in front of the layout when the header is turned off', () => {
        const rebased = assert_valid_at(rebase_pending_edits_for_header(slot({
            rowLayout: deleted(3, 5),
            structuralBasis: xlsx_basis(3),
        }), { from: 3, to: 0, sourceRowCount: ROWS }), 0);
        expect(rebased.rowLayout?.runs).toEqual([{ kind: 'source', start: 0, count: ROWS }]);
        expect(rebased.rowLayout?.removedSourceRows).toEqual([{ start: 5, count: 1 }]);
        expect(rebased.structuralBasis).toMatchObject({ bodyStart: 0 });
    });

    it('drops an untouched front of the layout when a later row becomes the header', () => {
        const rebased = assert_valid_at(rebase_pending_edits_for_header(slot({
            rowLayout: deleted(1, 6),
            structuralBasis: xlsx_basis(1),
        }), { from: 1, to: 4, sourceRowCount: ROWS }), 4);
        expect(rebased.rowLayout?.runs).toEqual([{ kind: 'source', start: 4, count: ROWS - 4 }]);
        expect(rebased.rowLayout?.removedSourceRows).toEqual([{ start: 6, count: 1 }]);
        expect(rebased.structuralBasis).toMatchObject({ bodyStart: 4 });
    });

    it('leaves a legacy basis\'s unknown body start unknown, rather than claiming the new one', () => {
        // Save treats an absent body start as unknown and lets the digests
        // decide; stamping `to` would vouch for a body start never checked.
        const { bodyStart: _unknown, ...legacy } = xlsx_basis(1) as Extract<
            NonNullable<PendingStructuralChanges['structuralBasis']>,
            { kind: 'xlsx' }
        >;
        const rebased = assert_valid_at(rebase_pending_edits_for_header(slot({
            rowLayout: deleted(1, 6),
            structuralBasis: legacy,
        }), { from: 1, to: 4, sourceRowCount: ROWS }), 4);
        expect(rebased.structuralBasis).toEqual(legacy);
    });

    it('keeps an inserted row and a moved row below the rows that leave the body', () => {
        const inserted = layout_ok(insert_rows(
            source_row_layout(1, ROWS - 1),
            { kind: 'source', sourceRow: 6 },
            'after',
            ['new-row'],
        ));
        const moved = layout_ok(move_rows(
            inserted,
            [{ kind: 'source', sourceRow: 8 }],
            { kind: 'source', sourceRow: 5 },
        ));
        const rebased = assert_valid_at(rebase_pending_edits_for_header(
            {
                cells: {},
                rowLayout: moved,
                appendedRows: [{
                    id: 'new-row',
                    origin: 'insert',
                    cells: {},
                    formatTemplateId: 't',
                    createdOrder: 1,
                }],
            } as HeaderRebaseSlot,
            { from: 1, to: 3, sourceRowCount: ROWS },
        ), 3);
        expect(rebased.rowLayout?.runs[0]).toEqual({ kind: 'source', start: 3, count: 2 });
    });

    it('round-trips: off and back on gives the same layout and basis', () => {
        const start = slot({ rowLayout: deleted(1, 5), structuralBasis: xlsx_basis(1) });
        const off = rebase_pending_edits_for_header(start, { from: 1, to: 0, sourceRowCount: ROWS });
        if (!off.ok) throw new Error(off.message);
        const on = rebase_pending_edits_for_header(off.slot, { from: 0, to: 1, sourceRowCount: ROWS });
        if (!on.ok) throw new Error(on.message);
        expect(on.slot.rowLayout).toEqual(start.rowLayout);
        expect(on.slot.structuralBasis).toEqual(start.structuralBasis);
    });

    it('re-stamps the append basis with the new column names, with or without pending rows', () => {
        const appendBasis = { sourceRowCount: ROWS, columnCount: 2, schemaFingerprint: 'old' };
        const result = rebase_pending_edits_for_header(slot({ appendBasis }), {
            from: 1, to: 0, sourceRowCount: ROWS, appendSchemaFingerprint: 'new',
        });
        expect(result.ok && result.slot.appendBasis).toEqual({ ...appendBasis, schemaFingerprint: 'new' });
        // The webview's precheck can't compute it and leaves it alone.
        const precheck = rebase_pending_edits_for_header(slot({ appendBasis }), {
            from: 1, to: 0, sourceRowCount: ROWS,
        });
        expect(precheck.ok && precheck.slot.appendBasis).toBe(appendBasis);
    });

    it('refuses a deleted row among the rows that would leave the body', () => {
        expect(rebase_pending_edits_for_header(slot({ rowLayout: deleted(1, 2) }), {
            from: 1, to: 4, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_PREFIX_MESSAGE });
    });

    it('refuses a moved row or a pending row in front of the rows that would leave the body', () => {
        const moved = layout_ok(move_rows(
            source_row_layout(1, ROWS - 1),
            [{ kind: 'source', sourceRow: 7 }],
            { kind: 'source', sourceRow: 1 },
        ));
        expect(rebase_pending_edits_for_header(slot({ rowLayout: moved }), {
            from: 1, to: 3, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_PREFIX_MESSAGE });
        const inserted = layout_ok(insert_rows(
            source_row_layout(1, ROWS - 1),
            { kind: 'source', sourceRow: 1 },
            'before',
            ['p'],
        ));
        expect(rebase_pending_edits_for_header(slot({ rowLayout: inserted }), {
            from: 1, to: 3, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_PREFIX_MESSAGE });
    });

    it('refuses a pending tail removal above the new header', () => {
        expect(rebase_pending_edits_for_header(slot({
            tailRemovals: [{
                appendHistoryId: 'a',
                sourceRow: 2,
                savedFingerprint: 'f',
                savedRow: { cells: {}, format: {} as never },
            }],
        }), { from: 1, to: 4, sourceRowCount: ROWS }))
            .toEqual({ ok: false, message: HEADER_REBASE_PREFIX_MESSAGE });
    });

    it('refuses any pending change on the row that would become, or stop being, the header', () => {
        expect(rebase_pending_edits_for_header(slot({ cells: { '3:0': 'Name' } }), {
            from: 1, to: 4, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_NEW_HEADER_CELL_MESSAGE });
        expect(rebase_pending_edits_for_header(slot({ cells: { '0:1': 'Qty' } }), {
            from: 1, to: 0, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_OLD_HEADER_CELL_MESSAGE });
        // A plain value is refused too: `007` is text in a header and a number in the body.
        expect(rebase_pending_edits_for_header(slot({ cells: { '0:0': { value: '007', base: 'id' } } }), {
            from: 0, to: 1, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_NEW_HEADER_CELL_MESSAGE });
    });

    it('refuses a pending change on a row the change newly hides, but not on one already hidden', () => {
        expect(rebase_pending_edits_for_header(slot({ cells: { '1:0': 'x' } }), {
            from: 1, to: 4, sourceRowCount: ROWS, hiddenAfter: [0, 1, 2],
        })).toEqual({ ok: false, message: HEADER_REBASE_HIDDEN_CELL_MESSAGE });
        expect(rebase_pending_edits_for_header(slot({ cells: { '1:0': 'x' } }), {
            from: 4, to: 0, sourceRowCount: ROWS, hiddenBefore: [1], hiddenAfter: [1],
        }).ok).toBe(true);
    });

    it('refuses inserted or moved rows when rows end up hidden, which turns off layout view', () => {
        const inserted = layout_ok(insert_rows(
            source_row_layout(1, ROWS - 1),
            { kind: 'source', sourceRow: 8 },
            'after',
            ['p'],
        ));
        expect(rebase_pending_edits_for_header(slot({ rowLayout: inserted }), {
            from: 1, to: 4, sourceRowCount: ROWS, hiddenAfter: [0, 1, 2],
        })).toEqual({ ok: false, message: HEADER_REBASE_TRANSFORMED_MESSAGE });
        // A deleted row renders under hidden rows: allowed.
        expect(rebase_pending_edits_for_header(slot({ rowLayout: deleted(1, 8) }), {
            from: 1, to: 4, sourceRowCount: ROWS, hiddenAfter: [0, 1, 2],
        }).ok).toBe(true);
    });

    it('refuses a recorded layout conflict, a basis authored at another body start, and a live Pending Column', () => {
        const conflict = { reason: 'structuralBasisChanged' as const, pendingRowIds: [], tailRemovalIds: [] };
        expect(rebase_pending_edits_for_header(slot({ conflicts: [conflict] }), {
            from: 1, to: 0, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_CONFLICT_MESSAGE });
        expect(rebase_pending_edits_for_header(slot({ structuralBasis: xlsx_basis(2) }), {
            from: 1, to: 0, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_CONFLICT_MESSAGE });
        const column = {
            id: 'c', header: 'New', cells: {}, format: {} as never, createdOrder: 1,
        };
        expect(rebase_pending_edits_for_header(slot({ pendingColumns: [column] }), {
            from: 1, to: 0, sourceRowCount: ROWS,
        })).toEqual({ ok: false, message: HEADER_REBASE_PENDING_COLUMN_MESSAGE });
        expect(header_rebase_slot_refusal(slot({ pendingColumns: [column] }), 1))
            .toBe(HEADER_REBASE_PENDING_COLUMN_MESSAGE);
        expect(header_rebase_slot_refusal(slot({ structuralBasis: xlsx_basis(1) }), 1)).toBeUndefined();
    });
});
