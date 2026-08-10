import { describe, it, expect } from 'vitest';
import {
    decode_stored_per_file_state,
    has_any_pending_edits,
    pending_edits_for_sheet,
    reconcile_pending_edit_sheets,
    with_pending_edits_for_sheet,
} from '../types';
import type { PerFileState } from '../types';

const entry = (value: string, base = '') => ({ value, base });

/** Decode and narrow to the modern arm; `StoredPerFileState`'s legacy arm has no such leaf. */
function decoded_edits(value: unknown): PerFileState['pendingEdits'] {
    return (decode_stored_per_file_state(value) as PerFileState).pendingEdits;
}

describe('decode_stored_per_file_state — pendingEdits migration', () => {
    it('migrates a legacy flat map to slot 0 with no sheet name', () => {
        // Only CSV was ever editable and CSV is single-sheet, so slot 0 *is* the
        // sheet. No name is recorded because none was ever knowable.
        const decoded = decoded_edits({
            pendingEdits: { '0:0': entry('x'), '3:1': 'y' },
        });
        expect(decoded).toEqual([
            { cells: { '0:0': entry('x'), '3:1': 'y' } },
        ]);
    });

    it('drops an empty legacy map', () => {
        expect(decoded_edits({ pendingEdits: {} })).toBeUndefined();
    });

    it('accepts the worksheet-scoped array shape', () => {
        const decoded = decoded_edits({
            pendingEdits: [
                { sheetName: 'Sales', cells: { '0:0': entry('a') } },
                undefined,
                { sheetName: 'Costs', cells: { '2:1': entry('b') } },
            ],
        });
        expect(decoded).toHaveLength(3);
        expect(decoded![0]!.sheetName).toBe('Sales');
        expect(decoded![1]).toBeUndefined();
        expect(decoded![2]!.sheetName).toBe('Costs');
    });

    it('trims trailing empty slots so the array cannot grow monotonically', () => {
        const decoded = decoded_edits({
            pendingEdits: [{ cells: { '0:0': entry('a') } }, undefined, { cells: {} }],
        });
        expect(decoded).toHaveLength(1);
    });

    it('drops the leaf when no slot holds anything', () => {
        const decoded = decoded_edits({
            pendingEdits: [undefined, { cells: {} }],
        });
        expect(decoded).toBeUndefined();
    });

    it('rejects malformed slots rather than silently dropping edits', () => {
        expect(() => decode_stored_per_file_state({ pendingEdits: [{ cells: 5 }] })).toThrow();
        expect(() => decode_stored_per_file_state({ pendingEdits: [{ cells: { bad: entry('x') } }] })).toThrow();
        expect(() => decode_stored_per_file_state({
            pendingEdits: [{ sheetName: 7, cells: { '0:0': entry('x') } }],
        })).toThrow();
        expect(() => decode_stored_per_file_state({
            pendingEdits: [{ cells: { '0:0': { value: 'x' } } }],
        })).toThrow();
    });

    it('round-trips a decoded array unchanged', () => {
        const once = decoded_edits({
            pendingEdits: [{ sheetName: 'S', cells: { '1:2': entry('v', 'b') } }],
        });
        expect(decoded_edits({ pendingEdits: once })).toEqual(once);
    });
});

describe('pending_edits_for_sheet', () => {
    const state: PerFileState['pendingEdits'] = [
        { sheetName: 'A', cells: { '0:0': entry('a') } },
        undefined,
        { sheetName: 'C', cells: { '1:1': entry('c') } },
    ];

    it('reads the addressed sheet only', () => {
        expect(pending_edits_for_sheet(state, 0)).toEqual({ '0:0': entry('a') });
        expect(pending_edits_for_sheet(state, 2)).toEqual({ '1:1': entry('c') });
    });

    it('returns undefined for an empty, absent or out-of-range slot', () => {
        expect(pending_edits_for_sheet(state, 1)).toBeUndefined();
        expect(pending_edits_for_sheet(state, 9)).toBeUndefined();
        expect(pending_edits_for_sheet(undefined, 0)).toBeUndefined();
    });
});

describe('with_pending_edits_for_sheet', () => {
    it('writes a slot without disturbing its neighbours', () => {
        const before: PerFileState['pendingEdits'] = [
            { sheetName: 'A', cells: { '0:0': entry('a') } },
            { sheetName: 'B', cells: { '1:0': entry('b') } },
        ];
        const after = with_pending_edits_for_sheet(before, 1, { '2:0': entry('B2') }, 'B');
        // The neighbouring sheet's unsaved work is the thing most at risk here.
        expect(pending_edits_for_sheet(after, 0)).toEqual({ '0:0': entry('a') });
        expect(pending_edits_for_sheet(after, 1)).toEqual({ '2:0': entry('B2') });
    });

    it('clears one sheet and leaves the rest — the save/discard path', () => {
        const before: PerFileState['pendingEdits'] = [
            { sheetName: 'A', cells: { '0:0': entry('a') } },
            { sheetName: 'B', cells: { '1:0': entry('b') } },
        ];
        const after = with_pending_edits_for_sheet(before, 0, undefined);
        expect(pending_edits_for_sheet(after, 0)).toBeUndefined();
        expect(pending_edits_for_sheet(after, 1)).toEqual({ '1:0': entry('b') });
    });

    it('grows the array to reach a later sheet', () => {
        const after = with_pending_edits_for_sheet(undefined, 3, { '0:0': entry('x') }, 'D');
        expect(after).toHaveLength(4);
        expect(pending_edits_for_sheet(after, 3)).toEqual({ '0:0': entry('x') });
    });

    it('drops the leaf entirely once the last edits are cleared', () => {
        const before: PerFileState['pendingEdits'] = [{ sheetName: 'A', cells: { '0:0': entry('a') } }];
        expect(with_pending_edits_for_sheet(before, 0, undefined)).toBeUndefined();
        expect(with_pending_edits_for_sheet(before, 0, {})).toBeUndefined();
    });

    it('records the sheet name when given one', () => {
        const after = with_pending_edits_for_sheet(undefined, 0, { '0:0': entry('x') }, 'Sales');
        expect(after![0]!.sheetName).toBe('Sales');
    });

    it('omits the name when none is supplied, matching legacy slots', () => {
        const after = with_pending_edits_for_sheet(undefined, 0, { '0:0': entry('x') });
        expect(after![0]).toEqual({ cells: { '0:0': entry('x') } });
    });
});

describe('has_any_pending_edits', () => {
    it('reports across all sheets, not just the first', () => {
        expect(has_any_pending_edits(undefined)).toBe(false);
        expect(has_any_pending_edits([])).toBe(false);
        expect(has_any_pending_edits([undefined, { cells: {} }])).toBe(false);
        expect(has_any_pending_edits([undefined, { cells: { '0:0': entry('x') } }])).toBe(true);
    });
});

describe('reconcile_pending_edit_sheets', () => {
    it('keeps slots whose name still matches its position', () => {
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'A', cells: { '0:0': entry('a') } },
            { sheetName: 'B', cells: { '0:0': entry('b') } },
        ];
        expect(reconcile_pending_edit_sheets(pending, ['A', 'B'])).toBe(pending);
    });

    it('follows a sheet that moved, rather than editing the wrong worksheet', () => {
        // The workbook was reordered in Excel between sessions. Honouring slot 0
        // by position would apply Sales' draft to Costs, keyed to rows that mean
        // something else there; names are unique, so it moves instead.
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'Sales', cells: { '0:0': entry('a') } },
            { sheetName: 'Costs', cells: { '0:0': entry('b') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['Costs', 'Sales']);
        expect(pending_edits_for_sheet(after, 0)).toEqual({ '0:0': entry('b') });
        expect(pending_edits_for_sheet(after, 1)).toEqual({ '0:0': entry('a') });
    });

    it('drops only a sheet the workbook no longer has', () => {
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'A', cells: { '0:0': entry('a') } },
            { sheetName: 'B', cells: { '0:0': entry('b') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['A', 'Renamed']);
        expect(pending_edits_for_sheet(after, 0)).toEqual({ '0:0': entry('a') });
        expect(pending_edits_for_sheet(after, 1)).toBeUndefined();
    });

    it('moves a draft to a sheet that shifted position', () => {
        // A sheet inserted ahead of the edited one — the common reorder, and the
        // one where dropping the draft would lose work for no reason.
        const pending: PerFileState['pendingEdits'] = [
            undefined,
            { sheetName: 'Sales', cells: { '0:0': entry('a') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['New', 'Extra', 'Sales']);
        expect(pending_edits_for_sheet(after, 1)).toBeUndefined();
        expect(pending_edits_for_sheet(after, 2)).toEqual({ '0:0': entry('a') });
    });

    it('keeps unnamed legacy slots, which are single-sheet CSV by construction', () => {
        const pending: PerFileState['pendingEdits'] = [{ cells: { '0:0': entry('a') } }];
        expect(reconcile_pending_edit_sheets(pending, ['Anything'])).toBe(pending);
    });

    it('drops a slot past the end of a workbook that lost sheets', () => {
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'A', cells: { '0:0': entry('a') } },
            { sheetName: 'B', cells: { '0:0': entry('b') } },
        ];
        expect(reconcile_pending_edit_sheets(pending, ['A'])).toHaveLength(1);
    });

    it('keeps both drafts when two slots ended up tagged with one name', () => {
        // Names are unique within a workbook, but slots are written over time: a
        // sheet renamed externally onto a name another slot already recorded leaves
        // two tags alike until the next write. Assigning both to the same position
        // deleted the loser's unsaved work outright, which is the one outcome this
        // whole reconciliation exists to avoid.
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'Inventory', cells: { '0:0': entry('first') } },
            { sheetName: 'Inventory', cells: { '0:0': entry('second') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['People', 'Inventory']);
        const kept = (after ?? []).map((slot) => slot?.cells?.['0:0']);
        expect(kept).toEqual(
            expect.arrayContaining([entry('first'), entry('second')]),
        );
    });

    it('passes an absent leaf through', () => {
        expect(reconcile_pending_edit_sheets(undefined, ['A'])).toBeUndefined();
    });
});
