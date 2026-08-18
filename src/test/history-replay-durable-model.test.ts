import { describe, expect, it } from 'vitest';
import type { CellHyperlink, RichText } from '../cell-content';
import {
    entry_from_wire_overlay,
    pending_edits_with_replay_writes,
    prepared_content_unchanged,
    replay_cell_key,
    replay_cell_matches,
    replay_highlight_matches,
    replay_highlight_patches,
    stored_entry,
    type ReplayCellExpectation,
} from '../history-replay-durable-model';
import type { WireCellOverlayState, WireHistoryValue } from '../history-replay-protocol';
import { make_dirty_entry, type CsvDirtyEntry, type SheetPendingEditCells } from '../types';

const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/' };
const OTHER: CellHyperlink = { kind: 'internal', location: 'B2' };
const BOLD: RichText = { runs: [{ text: 'typed', style: { bold: true } }] };
const PLAIN: WireHistoryValue = { text: 'disk' };

const absent: WireCellOverlayState = { kind: 'absent' };

/**
 * The three legal present arms. A wire overlay that touches NEITHER dimension is
 * not a state the union admits — it would be no overlay at all — so an untouched
 * value dimension only ever arrives beside a present hyperlink.
 */
function value_overlay(
    value: WireHistoryValue,
    base: WireHistoryValue,
    base_pending = false,
): WireCellOverlayState {
    return {
        kind: 'present',
        value: { kind: 'present', value, base, basePending: base_pending },
        hyperlink: { kind: 'untouched' },
    };
}

function link_overlay(
    anchor: WireHistoryValue,
    link: CellHyperlink | null,
    base_link: CellHyperlink | null = null,
): WireCellOverlayState {
    return {
        kind: 'present',
        value: { kind: 'untouched', anchor },
        hyperlink: { kind: 'present', value: link, base: base_link },
    };
}

function combined_overlay(
    value: WireHistoryValue,
    base: WireHistoryValue,
    link: CellHyperlink | null,
    base_link: CellHyperlink | null = null,
): WireCellOverlayState {
    return {
        kind: 'present',
        value: { kind: 'present', value, base, basePending: false },
        hyperlink: { kind: 'present', value: link, base: base_link },
    };
}

function cells(entries: Record<string, string | CsvDirtyEntry>): SheetPendingEditCells {
    return entries;
}

function expectation(
    overlay: WireCellOverlayState,
    persisted: WireHistoryValue = PLAIN,
): ReplayCellExpectation {
    return { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, overlay, persisted };
}

describe('replay_cell_key', () => {
    it('is the row:col source key durable state already uses', () => {
        expect(replay_cell_key(3, 4)).toBe('3:4');
        expect(replay_cell_key(0, 0)).toBe('0:0');
    });
});

describe('entry_from_wire_overlay', () => {
    it('reports an absent overlay as absent rather than as an empty entry', () => {
        expect(entry_from_wire_overlay(absent)).toEqual({ kind: 'absent' });
    });

    it('projects an untouched value dimension onto both sides of the entry', () => {
        const projection = entry_from_wire_overlay(
            link_overlay({ text: 'kept', runs: BOLD }, LINK),
        );
        expect(projection.kind).toBe('entry');
        if (projection.kind !== 'entry') return;
        expect(projection.entry.value).toBe('kept');
        expect(projection.entry.base).toBe('kept');
        expect(projection.entry.link).toEqual(LINK);
    });

    it('projects a present value dimension with each side distinct', () => {
        const projection = entry_from_wire_overlay(
            value_overlay({ text: 'new' }, { text: 'old' }),
        );
        expect(projection.kind).toBe('entry');
        if (projection.kind !== 'entry') return;
        expect(projection.entry.value).toBe('new');
        expect(projection.entry.base).toBe('old');
        expect(projection.entry.link).toBeUndefined();
    });

    it('refuses a base-pending overlay, which durable state cannot represent', () => {
        // The renderer's own planner refuses such a cell; reaching here is a
        // stale renderer, and matching nothing is the safe answer.
        expect(entry_from_wire_overlay(
            value_overlay({ text: 'new' }, { text: '' }, true),
        )).toEqual({ kind: 'unrepresentable' });
    });

    it('distinguishes a cleared link from an untouched one', () => {
        const cleared = entry_from_wire_overlay(
            combined_overlay({ text: 'new' }, { text: 'disk' }, null),
        );
        const untouched = entry_from_wire_overlay(
            value_overlay({ text: 'new' }, { text: 'disk' }),
        );
        expect(cleared.kind === 'entry' && cleared.entry.link).toBeNull();
        expect(untouched.kind === 'entry' && untouched.entry.link).toBeUndefined();
    });
});

describe('stored_entry', () => {
    it('canonicalizes a legacy string against the content it was made on top of', () => {
        const entry = stored_entry('typed', { text: 'disk', runs: undefined });
        expect(entry?.value).toBe('typed');
        expect(entry?.base).toBe('disk');
    });

    it('carries the persisted runs onto the legacy entry base', () => {
        const entry = stored_entry('typed', { text: 'typed', runs: BOLD });
        expect(entry?.baseRuns).toEqual(BOLD);
    });

    it('passes a full entry through untouched', () => {
        const full = make_dirty_entry('a', 'b');
        expect(stored_entry(full, PLAIN)).toBe(full);
    });

    it('reports a missing cell as missing', () => {
        expect(stored_entry(undefined, PLAIN)).toBeUndefined();
    });
});

describe('replay_cell_matches', () => {
    it('accepts an absent overlay only when no key is stored', () => {
        expect(replay_cell_matches(undefined, expectation(absent))).toBe(true);
        expect(replay_cell_matches(cells({}), expectation(absent))).toBe(true);
        expect(replay_cell_matches(
            cells({ '3:4': make_dirty_entry('new', 'disk') }),
            expectation(absent),
        )).toBe(false);
    });

    it('reads membership off the map, not off semantic inequality', () => {
        // The whole point: an entry whose value equals its base is genuinely in
        // the map — tinted, persisted, saved — and an absent overlay must not
        // match it.
        expect(replay_cell_matches(
            cells({ '3:4': make_dirty_entry('same', 'same') }),
            expectation(absent),
        )).toBe(false);
        expect(replay_cell_matches(
            cells({ '3:4': make_dirty_entry('same', 'same') }),
            expectation(value_overlay({ text: 'same' }, { text: 'same' })),
        )).toBe(true);
    });

    it('refuses a present overlay when the cell holds nothing', () => {
        expect(replay_cell_matches(
            cells({}),
            expectation(value_overlay({ text: 'new' }, { text: 'disk' })),
        )).toBe(false);
    });

    it('refuses when the stored entry has moved', () => {
        expect(replay_cell_matches(
            cells({ '3:4': make_dirty_entry('elsewhere', 'disk') }),
            expectation(value_overlay({ text: 'new' }, { text: 'disk' })),
        )).toBe(false);
    });

    it('compares a legacy string entry through the persisted content', () => {
        expect(replay_cell_matches(
            cells({ '3:4': 'new' }),
            expectation(value_overlay({ text: 'new' }, { text: 'disk' })),
        )).toBe(true);
        expect(replay_cell_matches(
            cells({ '3:4': 'new' }),
            expectation(value_overlay({ text: 'new' }, { text: 'other' })),
        )).toBe(false);
    });

    it('refuses a base-pending overlay however the cell looks', () => {
        const pending = expectation(value_overlay({ text: 'new' }, { text: '' }, true));
        expect(replay_cell_matches(cells({}), pending)).toBe(false);
        expect(replay_cell_matches(cells({ '3:4': make_dirty_entry('new', '') }), pending)).toBe(false);
    });

    it('distinguishes the link dimension', () => {
        const stored = make_dirty_entry('t', 't', undefined, undefined, LINK, null);
        expect(replay_cell_matches(
            cells({ '3:4': stored }),
            expectation(link_overlay({ text: 't' }, LINK)),
        )).toBe(true);
        expect(replay_cell_matches(
            cells({ '3:4': stored }),
            expectation(link_overlay({ text: 't' }, OTHER)),
        )).toBe(false);
        expect(replay_cell_matches(
            cells({ '3:4': stored }),
            expectation(value_overlay({ text: 't' }, { text: 't' })),
        )).toBe(false);
    });

    it('reads a foreign or empty slot as holding nothing', () => {
        // `pending_edits_for_sheet` answers undefined for a slot belonging to
        // another worksheet, and for this question that is the same as no entry.
        expect(replay_cell_matches(
            undefined,
            expectation(value_overlay({ text: 'new' }, { text: 'disk' })),
        )).toBe(false);
    });
});

describe('pending_edits_with_replay_writes', () => {
    const entry = make_dirty_entry('new', 'disk');

    it('leaves the map alone when there is nothing to write', () => {
        const before = cells({ '1:1': entry });
        expect(pending_edits_with_replay_writes(before, [])).toBe(before);
    });

    it('adds an entry to an absent cell', () => {
        const after = pending_edits_with_replay_writes(undefined, [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry },
        ]);
        expect(after).toEqual({ '3:4': entry });
    });

    it('removes an entry a replay undoes', () => {
        const after = pending_edits_with_replay_writes(cells({ '3:4': entry, '1:1': entry }), [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry: null },
        ]);
        expect(after).toEqual({ '1:1': entry });
    });

    it('clears the slot entirely when the last entry goes', () => {
        // Not an empty map: `with_pending_edits_for_sheet` reads undefined as
        // "this worksheet has no draft", which is what a fully undone sheet is.
        expect(pending_edits_with_replay_writes(cells({ '3:4': entry }), [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry: null },
        ])).toBeUndefined();
    });

    it('reports no change when every write already holds', () => {
        const before = cells({ '3:4': entry });
        expect(pending_edits_with_replay_writes(before, [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry: make_dirty_entry('new', 'disk') },
        ])).toBe(before);
    });

    it('reports no change for removing a cell that is not there', () => {
        const before = cells({ '1:1': entry });
        expect(pending_edits_with_replay_writes(before, [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry: null },
        ])).toBe(before);
    });

    it('replaces a legacy string entry with the full entry', () => {
        expect(pending_edits_with_replay_writes(cells({ '3:4': 'new' }), [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry },
        ])).toEqual({ '3:4': entry });
    });

    it('does not mutate the map it was given', () => {
        const before = cells({ '3:4': entry });
        pending_edits_with_replay_writes(before, [
            { sheetIndex: 0, sourceRow: 9, sourceColumn: 9, entry },
        ]);
        expect(before).toEqual({ '3:4': entry });
    });
});

describe('replay_highlight_matches', () => {
    it('treats absence and null as the same fact', () => {
        const base = { sheetIndex: 0, sourceRow: 2, sourceColumn: 5, desired: 'yellow' as const };
        expect(replay_highlight_matches(undefined, { ...base, expected: null })).toBe(true);
        expect(replay_highlight_matches({}, { ...base, expected: null })).toBe(true);
        expect(replay_highlight_matches({ '2:5': 'yellow' }, { ...base, expected: null })).toBe(false);
    });

    it('compares the stored colour', () => {
        const base = { sheetIndex: 0, sourceRow: 2, sourceColumn: 5, desired: null };
        expect(replay_highlight_matches({ '2:5': 'yellow' }, { ...base, expected: 'yellow' })).toBe(true);
        expect(replay_highlight_matches({ '2:5': 'green' }, { ...base, expected: 'yellow' })).toBe(false);
    });
});

describe('replay_highlight_patches', () => {
    it('groups writes by sheet in index order', () => {
        const patches = replay_highlight_patches([
            { sheetIndex: 2, sourceRow: 1, sourceColumn: 1, expected: null, desired: 'yellow' },
            { sheetIndex: 0, sourceRow: 4, sourceColumn: 2, expected: null, desired: 'green' },
            { sheetIndex: 2, sourceRow: 3, sourceColumn: 3, expected: 'green', desired: null },
        ]);
        expect(patches.map((patch) => patch.sheetIndex)).toEqual([0, 2]);
        expect(patches[0]?.cells).toEqual({ '4:2': 'green' });
        expect(patches[1]?.cells).toEqual({ '1:1': 'yellow', '3:3': null });
    });

    it('lets the last write to one cell win, matching replay order', () => {
        const patches = replay_highlight_patches([
            { sheetIndex: 0, sourceRow: 1, sourceColumn: 1, expected: null, desired: 'yellow' },
            { sheetIndex: 0, sourceRow: 1, sourceColumn: 1, expected: 'yellow', desired: null },
        ]);
        expect(patches[0]?.cells).toEqual({ '1:1': null });
    });

    it('produces nothing for no writes', () => {
        expect(replay_highlight_patches([])).toEqual([]);
    });
});

describe('prepared_content_unchanged', () => {
    const cell = (text: string, link: CellHyperlink | null = null, runs?: RichText) => ({
        persisted: { text, runs },
        persistedHyperlink: link,
    });

    it('accepts content that still reads the same', () => {
        expect(prepared_content_unchanged(
            [cell('a'), cell('b', LINK)],
            [cell('a'), cell('b', LINK)],
        )).toBe(true);
    });

    it('refuses when text moved', () => {
        expect(prepared_content_unchanged([cell('a')], [cell('z')])).toBe(false);
    });

    it('refuses when runs moved, so a styled undo cannot land unstyled', () => {
        expect(prepared_content_unchanged(
            [cell('typed', null, BOLD)],
            [cell('typed')],
        )).toBe(false);
    });

    it('refuses when a hyperlink moved', () => {
        expect(prepared_content_unchanged([cell('a', LINK)], [cell('a', OTHER)])).toBe(false);
        expect(prepared_content_unchanged([cell('a', LINK)], [cell('a', null)])).toBe(false);
    });

    it('refuses when the cell count moved', () => {
        expect(prepared_content_unchanged([cell('a')], [cell('a'), cell('b')])).toBe(false);
    });
});
