import { describe, it, expect } from 'vitest';
import {
    decode_stored_per_file_state,
    has_any_pending_edits,
    pending_edits_for_sheet,
    reconcile_pending_edit_sheets,
    stringify_stored_per_file_state,
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

    it('round-trips through the persisted wrapper', () => {
        // What actually goes to disk. The list is wrapped so `json_type` stays
        // 'object' and the CHECK v0.8.0 installed on existing databases still
        // passes — see `stringify_stored_per_file_state`.
        const state = {
            activeSheetIndex: 2,
            pendingEdits: [{ sheetName: 'S', cells: { '1:2': entry('v', 'b') } }],
        };
        const json = stringify_stored_per_file_state(state as never);
        expect(JSON.parse(json).pendingEdits).toEqual({ sheets: state.pendingEdits });
        expect(decode_stored_per_file_state(JSON.parse(json))).toEqual(state);
    });

    it('leaves a state with no pending edits unwrapped', () => {
        expect(stringify_stored_per_file_state({ activeSheetIndex: 1 } as never))
            .toBe('{"activeSheetIndex":1}');
    });

    it('rejects a wrapper carrying anything but the sheet list', () => {
        // The wrapper is told from a legacy flat map by its `sheets` key, so it has
        // to be exactly that and nothing else — otherwise a malformed leaf could be
        // read as a wrapper and silently lose the rest of its contents.
        expect(() => decode_stored_per_file_state({ pendingEdits: { sheets: {} } })).toThrow();
        expect(() => decode_stored_per_file_state({
            pendingEdits: { sheets: [{ cells: { '0:0': entry('x') } }], '0:0': entry('y') },
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

    it('parks a draft whose name the workbook no longer has', () => {
        // A deleted worksheet and a *renamed* one are indistinguishable here: both
        // are a tag that no longer resolves. Dropping the slot therefore deleted
        // unsaved work every time someone renamed a sheet in Excel with the file
        // open — durably, so renaming it back recovered nothing. Parked at its own
        // index instead: visible and dismissable, the recoverable way to be wrong.
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'A', cells: { '0:0': entry('a') } },
            { sheetName: 'B', cells: { '0:0': entry('b') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['A', 'Renamed']);
        expect(pending_edits_for_sheet(after, 0)).toEqual({ '0:0': entry('a') });
        expect(pending_edits_for_sheet(after, 1)).toEqual({ '0:0': entry('b') });
        expect(after?.[1]?.sheetName).toBe('B');
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

    it('keeps a slot past the end of a workbook that lost sheets', () => {
        // Same reason as above: the workbook shrinking does not distinguish a
        // deletion from a rename, and the slot beyond the last sheet is still the
        // user's unsaved work. It stays until they discard it.
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'A', cells: { '0:0': entry('a') } },
            { sheetName: 'B', cells: { '0:0': entry('b') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['A']);
        expect(after).toHaveLength(2);
        expect(pending_edits_for_sheet(after, 1)).toEqual({ '0:0': entry('b') });
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

    it('settles duplicate tags instead of shuffling them on every write', () => {
        // Reconciliation runs on every durable write, so its output is its own next
        // input. With three slots claiming one name it used to hand the position to
        // a different one each pass and displace the incumbent, so the drafts rotated
        // through the array forever and no slot index ever meant anything stable.
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'Inventory', cells: { '0:0': entry('first') } },
            { sheetName: 'Inventory', cells: { '0:0': entry('second') } },
            { sheetName: 'Inventory', cells: { '0:0': entry('third') } },
        ];
        const names = ['People', 'Inventory', 'Spare'];
        const once = reconcile_pending_edit_sheets(pending, names);
        const layout = (slots: PerFileState['pendingEdits']) =>
            (slots ?? []).map((slot) => JSON.stringify(slot?.cells?.['0:0']));
        expect(layout(once)).toEqual(
            expect.arrayContaining(
                ['first', 'second', 'third'].map((v) => JSON.stringify(entry(v))),
            ),
        );
        let settled = once;
        for (let pass = 0; pass < 4; pass++) {
            settled = reconcile_pending_edit_sheets(settled, names);
            expect(layout(settled)).toEqual(layout(once));
        }
    });

    it('does not let a duplicate-tag loser take an index another sheet is entitled to', () => {
        // A loser has no more claim on a position than a parked slot does. Placing
        // it as soon as it lost let it settle on an index a worksheet processed
        // later had a right to: `Costs` is entitled to 1, and found it taken.
        const pending: PerFileState['pendingEdits'] = [
            { sheetName: 'Inventory', cells: { '0:0': entry('inv-a') } },
            { sheetName: 'Inventory', cells: { '0:0': entry('inv-b') } },
            { sheetName: 'Costs', cells: { '0:0': entry('costs') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['Inventory', 'Costs', 'Spare']);
        expect(pending_edits_for_sheet(after, 1, 'Costs')).toEqual({ '0:0': entry('costs') });
        // And the displaced duplicate is kept, not deleted.
        expect(JSON.stringify(after)).toContain('inv-b');
    });

    it('does not let an untagged legacy slot outrank a sheet entitled to its index', () => {
        // An untagged slot is a draft written before slots carried names: it holds
        // its index by assumption only. Seating those before the named claimants let
        // assumption beat entitlement — `Data` moved externally from 1 to 0, found 0
        // already taken by the legacy slot, and was pushed aside, so opening `Data`
        // showed a foreign draft while its own was invisible.
        const pending: PerFileState['pendingEdits'] = [
            { cells: { '0:0': entry('legacy') } },
            { sheetName: 'Data', cells: { '0:0': entry('data') } },
        ];
        const after = reconcile_pending_edit_sheets(pending, ['Data', 'Other']);
        expect(pending_edits_for_sheet(after, 0, 'Data')).toEqual({ '0:0': entry('data') });
        // The legacy draft is kept, not deleted — just no longer in the way.
        expect(JSON.stringify(after)).toContain('legacy');
    });

    it('passes an absent leaf through', () => {
        expect(reconcile_pending_edit_sheets(undefined, ['A'])).toBeUndefined();
    });
});
