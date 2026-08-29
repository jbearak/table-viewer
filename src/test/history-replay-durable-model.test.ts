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
    write_value?: true,
    retain_value?: true,
    formatting_known?: true,
): WireCellOverlayState {
    return {
        kind: 'present',
        value: {
            kind: 'present',
            value,
            base,
            basePending: base_pending,
            ...(write_value === true ? { writeValue: true as const } : {}),
            ...(retain_value === true ? { retainValue: true as const } : {}),
            ...(formatting_known === true ? { formattingKnown: true as const } : {}),
        },
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
    persisted_hyperlink?: CellHyperlink | null,
): ReplayCellExpectation {
    return {
        sheetIndex: 0,
        sourceRow: 3,
        sourceColumn: 4,
        overlay,
        persisted,
        ...(persisted_hyperlink !== undefined
            ? { persistedHyperlink: persisted_hyperlink }
            : {}),
    };
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

    it('projects explicit equal-value write intent', () => {
        const projection = entry_from_wire_overlay(
            value_overlay({ text: 'A' }, { text: 'A' }, false, true),
        );
        expect(projection).toEqual({
            kind: 'entry',
            entry: { value: 'A', base: 'A', writeValue: true },
        });
    });

    it('projects retained equal-value membership without save-write intent', () => {
        const projection = entry_from_wire_overlay(
            value_overlay({ text: 'A' }, { text: 'A' }, false, undefined, true),
        );
        expect(projection).toEqual({
            kind: 'entry',
            entry: { value: 'A', base: 'A', retainValue: true },
        });
    });

    it('projects formatting and move metadata together', () => {
        const overlay: WireCellOverlayState = {
            kind: 'present',
            value: {
                kind: 'present',
                value: { text: 'new' },
                base: { text: 'old' },
                basePending: false,
                formattingKnown: true,
                movedFrom: { row: 4, col: 3, order: 7 },
                valueEditOrder: 8,
            },
            hyperlink: { kind: 'untouched' },
        };

        expect(entry_from_wire_overlay(overlay)).toEqual({
            kind: 'entry',
            entry: {
                value: 'new',
                base: 'old',
                formattingKnown: true,
                movedFrom: { row: 4, col: 3, order: 7 },
                valueEditOrder: 8,
            },
        });
    });

    it('projects a plain base-pending overlay as the bare string it came from', () => {
        // A pending base has exactly one origin in durable state: a bare string,
        // whose base is the empty placeholder and which carries neither runs nor
        // a link. Writing that shape back as a bare string is a faithful round
        // trip, so restoring the edit does not promote the placeholder base into
        // a real one.
        expect(entry_from_wire_overlay(
            value_overlay({ text: 'new' }, { text: '' }, true),
        )).toEqual({ kind: 'legacy', value: 'new' });
    });

    it('refuses a base-pending overlay that durable state has no shape for', () => {
        // Richer than a bare string in any dimension, so no durable form both
        // keeps the pending base and carries the rest. Matching nothing is the
        // safe answer.
        expect(entry_from_wire_overlay(
            value_overlay({ text: 'new', runs: BOLD }, { text: '' }, true),
        )).toEqual({ kind: 'unrepresentable' });
        expect(entry_from_wire_overlay(
            value_overlay({ text: 'new' }, { text: '', runs: BOLD }, true),
        )).toEqual({ kind: 'unrepresentable' });
        expect(entry_from_wire_overlay(
            value_overlay({ text: 'new' }, { text: 'disk' }, true),
        )).toEqual({ kind: 'unrepresentable' });
        expect(entry_from_wire_overlay({
            kind: 'present',
            value: { kind: 'present', value: { text: 'new' }, base: { text: '' }, basePending: true },
            hyperlink: { kind: 'present', value: LINK, base: null },
        })).toEqual({ kind: 'unrepresentable' });
        for (const metadata of [
            { writeValue: true as const },
            { retainValue: true as const },
            { formattingKnown: true as const },
            { movedFrom: { row: 1, col: 2, order: 3 } },
            { valueEditOrder: 3 },
        ]) {
            expect(entry_from_wire_overlay({
                kind: 'present',
                value: {
                    kind: 'present',
                    value: { text: 'new' },
                    base: { text: '' },
                    basePending: true,
                    ...metadata,
                },
                hyperlink: { kind: 'untouched' },
            })).toEqual({ kind: 'unrepresentable' });
        }
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
        expect(entry?.formattingKnown).toBe(true);
    });

    it('copies persisted runs to both sides of an equal legacy entry', () => {
        const entry = stored_entry('typed', { text: 'typed', runs: BOLD });
        expect(entry?.baseRuns).toEqual(BOLD);
        expect(entry?.valueRuns).toEqual(BOLD);
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
            expectation(
                value_overlay({ text: 'same' }, { text: 'same' }),
                { text: 'same' },
            ),
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
            expectation(value_overlay(
                { text: 'new' }, { text: 'disk' }, false,
                undefined, undefined, true,
            )),
        )).toBe(true);
        expect(replay_cell_matches(
            cells({ '3:4': 'new' }),
            expectation(value_overlay({ text: 'new' }, { text: 'other' })),
        )).toBe(false);
    });

    it('matches a resolved rich overlay against its equal legacy string', () => {
        expect(replay_cell_matches(
            cells({ '3:4': 'typed' }),
            expectation(value_overlay(
                { text: 'typed', runs: BOLD },
                { text: 'typed', runs: BOLD },
                false,
                undefined,
                undefined,
                true,
            ), { text: 'typed', runs: BOLD }),
        )).toBe(true);
    });

    it('matches a plain base-pending expectation against the stored bare string', () => {
        const pending = expectation(value_overlay({ text: 'new' }, { text: '' }, true));
        // Canonicalized against the persisted content, exactly as the store
        // hydrates a bare string, so the two spellings of the same cell agree.
        expect(replay_cell_matches(cells({ '3:4': 'new' }), pending)).toBe(true);
        expect(replay_cell_matches(cells({}), pending)).toBe(false);
        expect(replay_cell_matches(cells({ '3:4': 'other' }), pending)).toBe(false);
    });

    it('refuses an unrepresentable base-pending expectation however the cell looks', () => {
        const rich = expectation(value_overlay({ text: 'new', runs: BOLD }, { text: '' }, true));
        expect(replay_cell_matches(cells({}), rich)).toBe(false);
        expect(replay_cell_matches(cells({ '3:4': 'new' }), rich)).toBe(false);
        expect(replay_cell_matches(cells({ '3:4': make_dirty_entry('new', '') }), rich)).toBe(false);
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

    it('reconstructs the latest observed text side for the durable CAS', () => {
        const overlay = value_overlay({ text: 'pending' }, { text: 'original' });
        const observed = make_dirty_entry(
            'pending',
            'original',
            undefined,
            undefined,
            undefined,
            undefined,
            { value: 'current' },
        );
        expect(replay_cell_matches(
            cells({ '3:4': observed }),
            expectation(overlay, { text: 'current' }),
        )).toBe(true);
        expect(replay_cell_matches(
            cells({ '3:4': make_dirty_entry('pending', 'original') }),
            expectation(overlay, { text: 'current' }),
        )).toBe(false);
    });

    it('reconstructs the latest observed hyperlink side for the durable CAS', () => {
        const overlay = combined_overlay(
            { text: 'pending' },
            { text: 'original' },
            OTHER,
            LINK,
        );
        const observed = make_dirty_entry(
            'pending',
            'original',
            undefined,
            undefined,
            OTHER,
            LINK,
            { value: 'current', link: null },
        );
        expect(replay_cell_matches(
            cells({ '3:4': observed }),
            expectation(overlay, { text: 'current' }, null),
        )).toBe(true);
    });

    it('requires equal-value write intent to match exactly', () => {
        const overlay = value_overlay({ text: 'A' }, { text: 'A' }, false, true);
        const expected = expectation(overlay, { text: 'C' });
        expect(replay_cell_matches(cells({
            '3:4': make_dirty_entry(
                'A', 'A', undefined, undefined, undefined, undefined,
                { value: 'C' }, true,
            ),
        }), expected)).toBe(true);
        expect(replay_cell_matches(cells({
            '3:4': make_dirty_entry(
                'A', 'A', undefined, undefined, undefined, undefined,
                { value: 'C' },
            ),
        }), expected)).toBe(false);
    });

    it('canonicalizes an older equal sparse entry over styled persisted text', () => {
        const overlay = value_overlay({ text: 'A' }, { text: 'A' });
        const styled_a: RichText = {
            runs: [{ text: 'A', style: { bold: true } }],
        };
        expect(replay_cell_matches(
            cells({ '3:4': make_dirty_entry('A', 'A') }),
            expectation(overlay, { text: 'A', runs: styled_a }),
        )).toBe(true);
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

    it('writes a legacy string, restoring the unobserved base with it', () => {
        expect(pending_edits_with_replay_writes(undefined, [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry: 'new' },
        ])).toEqual({ '3:4': 'new' });
    });

    it('reports no change when the legacy string is already stored', () => {
        const before = cells({ '3:4': 'new' });
        expect(pending_edits_with_replay_writes(before, [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry: 'new' },
        ])).toBe(before);
    });

    it('writes a legacy string over an equal-valued entry', () => {
        // Not a no-op: the two forms differ in whether the base was observed,
        // and downgrading to the string is exactly what restoring the edit means.
        expect(pending_edits_with_replay_writes(cells({ '3:4': make_dirty_entry('new', '') }), [
            { sheetIndex: 0, sourceRow: 3, sourceColumn: 4, entry: 'new' },
        ])).toEqual({ '3:4': 'new' });
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
