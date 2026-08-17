import { describe, expect, it } from 'vitest';

import { rich_text_from_plain, type CellHyperlink, type RichText } from '../cell-content';
import {
    dirty_entry_link_changed,
    dirty_entry_value_changed,
    make_dirty_entry,
    type WorksheetTarget,
} from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    combined_overlay,
    delta_addresses_same_cell,
    delta_touches_hyperlink,
    delta_touches_value,
    dirty_entry_from_overlay_state,
    history_value,
    history_values_equal,
    hyperlink_only_overlay,
    overlay_for_direction,
    overlay_state_from_dirty_entry,
    overlay_states_equal,
    transition_side,
    value_only_overlay,
    type CellOverlayState,
    type HistoryDirtyEntry,
} from '../webview/history-cell-state-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Sheet1', worksheetId: 'ws-1' };

const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/a' };
const OTHER_LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/b' };

function styled(text: string): RichText {
    return { runs: [{ text, style: { bold: true } }] };
}

function present(state: CellOverlayState): Extract<CellOverlayState, { kind: 'present' }> {
    if (state.kind !== 'present') throw new Error('expected a present overlay');
    return state;
}

function delta(args: {
    before: CellOverlayState;
    after: CellOverlayState;
    persistedValue?: string;
    persistedRuns?: RichText;
    persistedHyperlink?: CellHyperlink | null;
}) {
    return build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: 3,
        sourceColumn: 2,
        before: args.before,
        after: args.after,
        persistedValue: history_value(args.persistedValue ?? '', args.persistedRuns),
        persistedHyperlink: args.persistedHyperlink ?? null,
    });
}

describe('history value equality', () => {
    it('treats a formatting-only difference as a real change', () => {
        // Same text, one side styled: editable_values_equal says this differs,
        // and history must agree or a formatting edit would record no action.
        expect(history_values_equal(history_value('x'), history_value('x', styled('x')))).toBe(false);
    });

    it('treats unstyled runs as equal to plain text of the same value', () => {
        expect(
            history_values_equal(history_value('x'), history_value('x', rich_text_from_plain('x'))),
        ).toBe(true);
    });

    it('distinguishes different text', () => {
        expect(history_values_equal(history_value('x'), history_value('y'))).toBe(false);
    });
});

describe('overlay_state_from_dirty_entry', () => {
    it('reads a value-only entry as a present value dimension and untouched link', () => {
        const state = present(overlay_state_from_dirty_entry(make_dirty_entry('B', 'A')));
        expect(state.value.kind).toBe('present');
        expect(state.hyperlink.kind).toBe('untouched');
    });

    it('reads a link-only entry as untouched value with an anchor', () => {
        // A link-only entry carries value === base (the unedited text); it must
        // not read as a value change, or undo would rewrite the cell's text.
        const entry = make_dirty_entry('A', 'A', undefined, undefined, LINK, null);
        expect(dirty_entry_value_changed(entry)).toBe(false);
        expect(dirty_entry_link_changed(entry)).toBe(true);

        const state = present(overlay_state_from_dirty_entry(entry));
        expect(state.value.kind).toBe('untouched');
        if (state.value.kind !== 'untouched') throw new Error('unreachable');
        expect(state.value.anchor.text).toBe('A');
        expect(state.hyperlink.kind).toBe('present');
    });

    it('reads an entry with both dimensions as both present', () => {
        const state = present(overlay_state_from_dirty_entry(
            make_dirty_entry('B', 'A', undefined, undefined, LINK, null),
        ));
        expect(state.value.kind).toBe('present');
        expect(state.hyperlink.kind).toBe('present');
    });

    it('keeps a present value dimension for a resolved legacy no-op entry', () => {
        // resolve_pending_bases captures a true base and drops base_pending,
        // so a legacy entry can become {value: A, base: A} with no link. It is
        // still IN the map — tinted, persisted, saved — so membership must be
        // retained even though the dimensions compare equal.
        const entry: HistoryDirtyEntry = make_dirty_entry('A', 'A');
        expect(dirty_entry_value_changed(entry)).toBe(false);

        const state = present(overlay_state_from_dirty_entry(entry));
        expect(state.value.kind).toBe('present');
        expect(state.hyperlink.kind).toBe('untouched');
    });

    it('keeps a present value dimension for an unresolved legacy entry', () => {
        const entry: HistoryDirtyEntry = { value: 'typed', base: '', base_pending: true };
        const state = present(overlay_state_from_dirty_entry(entry));
        expect(state.value.kind).toBe('present');
        if (state.value.kind !== 'present') throw new Error('unreachable');
        expect(state.value.basePending).toBe(true);
        expect(state.value.base.text).toBe('');
    });

    it('does not treat an unresolved entry that also has a link as link-only', () => {
        const entry: HistoryDirtyEntry = {
            ...make_dirty_entry('A', '', undefined, undefined, LINK, null),
            base_pending: true,
        };
        const state = present(overlay_state_from_dirty_entry(entry));
        expect(state.value.kind).toBe('present');
        if (state.value.kind !== 'present') throw new Error('unreachable');
        expect(state.value.basePending).toBe(true);
    });

    it('preserves run sides', () => {
        const state = present(overlay_state_from_dirty_entry(
            make_dirty_entry('x', 'x', styled('x'), undefined),
        ));
        expect(state.value.kind).toBe('present');
        if (state.value.kind !== 'present') throw new Error('unreachable');
        expect(state.value.value.runs).toEqual(styled('x'));
        expect(state.value.base.runs).toBeUndefined();
    });
});

describe('dirty_entry_from_overlay_state round trip', () => {
    const cases: ReadonlyArray<readonly [string, HistoryDirtyEntry]> = [
        ['value only', make_dirty_entry('B', 'A')],
        ['link only', make_dirty_entry('A', 'A', undefined, undefined, LINK, null)],
        ['link cleared', make_dirty_entry('A', 'A', undefined, undefined, null, LINK)],
        ['both dimensions', make_dirty_entry('B', 'A', undefined, undefined, LINK, OTHER_LINK)],
        ['styled value', make_dirty_entry('x', 'x', styled('x'), undefined)],
        ['resolved legacy no-op', make_dirty_entry('A', 'A')],
        ['unresolved legacy', { value: 'typed', base: '', base_pending: true }],
    ];

    for (const [name, entry] of cases) {
        it(`round-trips ${name}`, () => {
            const state = present(overlay_state_from_dirty_entry(entry));
            expect(dirty_entry_from_overlay_state(state)).toEqual(entry);
        });
    }

    it('keeps an absent link dimension absent rather than emitting null', () => {
        // `link: null` means "clear the link"; an absent field means "leave it".
        // Emitting null for a value-only entry would clear an unrelated link.
        const rebuilt = dirty_entry_from_overlay_state(
            present(overlay_state_from_dirty_entry(make_dirty_entry('B', 'A'))),
        );
        expect('link' in rebuilt).toBe(false);
        expect('baseLink' in rebuilt).toBe(false);
    });
});

describe('overlay_states_equal', () => {
    it('separates absent from a present overlay whose value equals the cell', () => {
        expect(overlay_states_equal(absent_overlay(), value_only_overlay(
            history_value('A'),
            history_value('A'),
        ))).toBe(false);
    });

    it('separates a value-only overlay from a link-only one', () => {
        expect(overlay_states_equal(
            value_only_overlay(history_value('A'), history_value('A')),
            hyperlink_only_overlay(history_value('A'), LINK, null),
        )).toBe(false);
    });

    it('separates base_pending from resolved', () => {
        expect(overlay_states_equal(
            value_only_overlay(history_value('t'), history_value(''), true),
            value_only_overlay(history_value('t'), history_value('')),
        )).toBe(false);
    });

    it('reports equal states as equal', () => {
        expect(overlay_states_equal(
            combined_overlay(history_value('B'), history_value('A'), LINK, null),
            combined_overlay(history_value('B'), history_value('A'), LINK, null),
        )).toBe(true);
    });
});

describe('build_cell_history_delta — sparse dimensions', () => {
    it('records no hyperlink transition for a value-only edit', () => {
        // The failure this prevents: disk has text X and link L; undo of a
        // value edit must not clear L.
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('B'), history_value('A')),
            persistedValue: 'A',
            persistedHyperlink: LINK,
        });
        expect(d).toBeDefined();
        expect(delta_touches_value(d!)).toBe(true);
        expect(delta_touches_hyperlink(d!)).toBe(false);
    });

    it('records no value transition for a link-only edit', () => {
        const d = delta({
            before: absent_overlay(),
            after: hyperlink_only_overlay(history_value('X'), LINK, null),
            persistedValue: 'X',
            persistedHyperlink: null,
        });
        expect(d).toBeDefined();
        expect(delta_touches_hyperlink(d!)).toBe(true);
        expect(delta_touches_value(d!)).toBe(false);
    });

    it('records both when a gesture moved both dimensions', () => {
        const d = delta({
            before: absent_overlay(),
            after: combined_overlay(history_value('B'), history_value('A'), LINK, null),
            persistedValue: 'A',
            persistedHyperlink: null,
        });
        expect(delta_touches_value(d!)).toBe(true);
        expect(delta_touches_hyperlink(d!)).toBe(true);
    });

    it('records a formatting-only change as a value transition', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('x', styled('x')), history_value('x')),
            persistedValue: 'x',
        });
        expect(d).toBeDefined();
        expect(delta_touches_value(d!)).toBe(true);
    });

    it('returns undefined for a semantic no-op', () => {
        const state = value_only_overlay(history_value('B'), history_value('A'));
        expect(delta({ before: state, after: state, persistedValue: 'A' })).toBeUndefined();
    });

    it('records a change to a cell that is blank on disk', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('typed'), history_value('')),
            persistedValue: '',
        });
        expect(d).toBeDefined();
        expect(transition_side(d!.value!, 'undo').content.text).toBe('');
        expect(transition_side(d!.value!, 'redo').content.text).toBe('typed');
    });

    it('records clearing a cell whose persisted content was not empty', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value(''), history_value('x')),
            persistedValue: 'x',
        });
        expect(d).toBeDefined();
        // Undo restores "x" and, being a membership transition, restores absence.
        expect(transition_side(d!.value!, 'undo').content.text).toBe('x');
        expect(transition_side(d!.value!, 'undo').overlay).toBe('absent');
        expect(transition_side(d!.value!, 'redo').overlay).toBe('present');
    });
});

describe('build_cell_history_delta — membership vs semantic mode', () => {
    it('uses membership mode when the overlay appeared', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('B'), history_value('A')),
            persistedValue: 'A',
        });
        expect(d!.value!.mode).toBe('membership');
    });

    it('uses membership mode when the overlay was removed (a discard)', () => {
        // Discard: overlay B removed, cell falls back to persisted A. Redo must
        // restore ABSENCE, not write A as a fresh edit — after an intervening
        // save that would overwrite the saved value.
        const d = delta({
            before: value_only_overlay(history_value('B'), history_value('A')),
            after: absent_overlay(),
            persistedValue: 'A',
        });
        expect(d!.value!.mode).toBe('membership');
        expect(overlay_for_direction(d!, 'undo').kind).toBe('present');
        expect(overlay_for_direction(d!, 'redo').kind).toBe('absent');
        expect(transition_side(d!.value!, 'redo').overlay).toBe('absent');
    });

    it('uses semantic mode when the overlay persisted across the edit', () => {
        const d = delta({
            before: value_only_overlay(history_value('B'), history_value('A')),
            after: value_only_overlay(history_value('C'), history_value('A')),
            persistedValue: 'A',
        });
        expect(d!.value!.mode).toBe('semantic');
        expect(transition_side(d!.value!, 'undo').content.text).toBe('B');
        expect(transition_side(d!.value!, 'redo').content.text).toBe('C');
    });

    it('records discarding a link-only entry without a value transition', () => {
        const d = delta({
            before: hyperlink_only_overlay(history_value('X'), LINK, null),
            after: absent_overlay(),
            persistedValue: 'X',
            persistedHyperlink: null,
        });
        expect(d).toBeDefined();
        expect(delta_touches_value(d!)).toBe(false);
        expect(delta_touches_hyperlink(d!)).toBe(true);
        expect(overlay_for_direction(d!, 'redo').kind).toBe('absent');
    });

    it('records discarding a resolved legacy no-op entry as a membership change', () => {
        // Nothing about the CONTENT changes here — only membership. A model
        // keyed on content alone would record nothing and lose the entry.
        const d = delta({
            before: value_only_overlay(history_value('A'), history_value('A')),
            after: absent_overlay(),
            persistedValue: 'A',
        });
        expect(d).toBeDefined();
        expect(transition_side(d!.value!, 'undo').overlay).toBe('present');
        expect(transition_side(d!.value!, 'redo').overlay).toBe('absent');
    });
});

describe('worksheet identity', () => {
    it('carries the full target, not just an index', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('B'), history_value('A')),
            persistedValue: 'A',
        });
        expect(d!.worksheet.worksheetId).toBe('ws-1');
        expect(d!.worksheet.sheetName).toBe('Sheet1');
    });

    it('matches by stable identity after a reorder changes the index', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('B'), history_value('A')),
            persistedValue: 'A',
        });
        const moved = { ...d!, worksheet: { ...SHEET, sheetIndex: 4 } };
        expect(delta_addresses_same_cell(d!, moved)).toBe(true);
    });

    it('does not match a different worksheet occupying the same index', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('B'), history_value('A')),
            persistedValue: 'A',
        });
        const other = {
            ...d!,
            worksheet: { sheetIndex: 0, sheetName: 'Sheet2', worksheetId: 'ws-2' },
        };
        expect(delta_addresses_same_cell(d!, other)).toBe(false);
    });
});
