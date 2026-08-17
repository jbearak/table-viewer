import { beforeEach, describe, expect, it } from 'vitest';

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
    canonical_cell_history_delta,
    combined_overlay,
    delta_addresses_same_cell,
    delta_touches_hyperlink,
    delta_touches_value,
    dirty_entry_from_overlay_state,
    history_value,
    history_values_equal,
    hyperlink_only_overlay,
    is_canonical_cell_delta,
    reset_interned_worksheet_targets,
    overlay_for_direction,
    overlay_state_from_dirty_entry,
    overlay_states_equal,
    transition_side,
    value_only_overlay,
    type CellHistoryDelta,
    type CellOverlayState,
    type HistoryDirtyEntry,
} from '../webview/history-cell-state-model';

beforeEach(reset_interned_worksheet_targets);

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

describe('per-dimension transition mode', () => {
    it('uses membership mode for a dimension that left while the cell stayed present', () => {
        // Reverting a pending hyperlink while a value edit remains: the cell is
        // present either side, but the LINK dimension left the overlay. If this
        // were semantic, a redo after an intervening save would replay the
        // historical link as a fresh edit over the saved one.
        const d = delta({
            before: combined_overlay(history_value('B'), history_value('A'), LINK, null),
            after: value_only_overlay(history_value('B'), history_value('A')),
            persistedValue: 'A',
            persistedHyperlink: null,
        });
        expect(d).toBeDefined();
        expect(d!.hyperlink!.mode).toBe('membership');
        expect(d!.hyperlink!.desired.overlay).toBe('absent');
        // The value dimension did not move, so it is not replayed at all.
        expect(d!.value).toBeUndefined();
    });

    it('uses membership mode for a dimension that joined while the cell stayed present', () => {
        const d = delta({
            before: value_only_overlay(history_value('B'), history_value('A')),
            after: combined_overlay(history_value('B'), history_value('A'), LINK, null),
            persistedValue: 'A',
            persistedHyperlink: null,
        });
        expect(d!.hyperlink!.mode).toBe('membership');
        expect(d!.value).toBeUndefined();
    });

    it('gives each dimension its own mode in one action', () => {
        // Value stays in the overlay (semantic) while the link leaves it
        // (membership) — one delta, two modes.
        const d = delta({
            before: combined_overlay(history_value('B'), history_value('A'), LINK, null),
            after: value_only_overlay(history_value('C'), history_value('A')),
            persistedValue: 'A',
            persistedHyperlink: null,
        });
        expect(d!.value!.mode).toBe('semantic');
        expect(d!.hyperlink!.mode).toBe('membership');
    });
});

describe('conflict-base metadata', () => {
    it('records a base change even when the effective value is unchanged', () => {
        // Disk moved A -> C under a pending B, so recommitting B rebases the
        // entry to {value: B, base: C}. Effective value is B either side, but
        // the base decides whether the cell reads as conflicted and whether
        // validate_dirty_bases admits the save.
        const d = delta({
            before: value_only_overlay(history_value('B'), history_value('A')),
            after: value_only_overlay(history_value('B'), history_value('C')),
            persistedValue: 'C',
        });
        expect(d).toBeDefined();
        expect(d!.value!.mode).toBe('semantic');
    });

    it('records a basePending change even when value and base are unchanged', () => {
        const d = delta({
            before: value_only_overlay(history_value('t'), history_value(''), true),
            after: value_only_overlay(history_value('t'), history_value('')),
            persistedValue: '',
        });
        expect(d).toBeDefined();
    });
});

describe('link added to an existing value entry', () => {
    it('does not read as a value change when the writer kept the value dimension', () => {
        // {value: A, base: A} + a link is produced BOTH by attaching a link to
        // an unedited cell and by attaching one to a resolved legacy no-op
        // entry. Only the writer knows which, so it declares its intent.
        const before_entry: HistoryDirtyEntry = make_dirty_entry('A', 'A');
        const after_entry: HistoryDirtyEntry = make_dirty_entry(
            'A', 'A', undefined, undefined, LINK, null,
        );

        const before = overlay_state_from_dirty_entry(before_entry);
        const after = overlay_state_from_dirty_entry(after_entry, 'in-overlay');

        const d = build_cell_history_delta({
            worksheet: SHEET,
            sourceRow: 3,
            sourceColumn: 2,
            before,
            after,
            persistedValue: history_value('A'),
            persistedHyperlink: null,
        });
        expect(d).toBeDefined();
        // Only the link moved: the value dimension was present before and after.
        expect(d!.hyperlink).toBeDefined();
        expect(d!.value).toBeUndefined();
    });

    it('reads a text revert that leaves a pending link as link-only', () => {
        // settle_edit: "the entry survives as link-only, its value dimension
        // back at the base". The prior state HAD a value dimension, so prior
        // membership is the wrong signal — the writer's intent is what counts.
        // Misreading this as combined would emit a semantic value transition,
        // and a redo after a save would write the stale text over the saved one.
        const before = combined_overlay(history_value('B'), history_value('A'), LINK, null);
        const after = overlay_state_from_dirty_entry(
            make_dirty_entry('A', 'A', undefined, undefined, LINK, null),
            'link-only',
        );
        expect(after.value.kind).toBe('untouched');

        const d = build_cell_history_delta({
            worksheet: SHEET,
            sourceRow: 3,
            sourceColumn: 2,
            before,
            after,
            persistedValue: history_value('A'),
            persistedHyperlink: null,
        });
        expect(d).toBeDefined();
        expect(d!.value!.mode).toBe('membership');
        expect(d!.value!.desired.overlay).toBe('absent');
    });

    it('records a link-only anchor base moving under an external change', () => {
        // Disk A -> C, then recommitting C: the link never moved, but the
        // anchor IS the reconstructed value/base pair, so the base the save is
        // validated against changed.
        const d = delta({
            before: hyperlink_only_overlay(history_value('A'), LINK, null),
            after: hyperlink_only_overlay(history_value('C'), LINK, null),
            persistedValue: 'C',
        });
        expect(d).toBeDefined();
    });

    it('records a hyperlink base moving while its value does not', () => {
        const d = delta({
            before: hyperlink_only_overlay(history_value('A'), LINK, null),
            after: hyperlink_only_overlay(history_value('A'), LINK, OTHER_LINK),
            persistedValue: 'A',
        });
        expect(d).toBeDefined();
    });

    it('still reads a link on a cell with no prior entry as link-only', () => {
        const state = overlay_state_from_dirty_entry(
            make_dirty_entry('A', 'A', undefined, undefined, LINK, null),
        );
        expect(present(state).value.kind).toBe('untouched');
    });

    it('round-trips an unresolved entry that also carries a cleared link', () => {
        const entry: HistoryDirtyEntry = {
            ...make_dirty_entry('typed', '', undefined, undefined, null, LINK),
            base_pending: true,
        };
        const state = present(overlay_state_from_dirty_entry(entry));
        const rebuilt = dirty_entry_from_overlay_state(state);
        expect(rebuilt).toEqual(entry);
        expect('link' in rebuilt).toBe(true);
        expect(rebuilt.link).toBeNull();
        expect(rebuilt.baseLink).toEqual(LINK);
        expect(rebuilt.base_pending).toBe(true);
    });
});

describe('history ownership', () => {
    it('is unaffected by later mutation of the objects it was built from', () => {
        const runs: RichText = rich_text_from_plain('x', { bold: true });
        const link: { kind: 'external'; target: string } = {
            kind: 'external',
            target: 'https://example.com/a',
        };
        const worksheet = { sheetIndex: 0, sheetName: 'Sheet1', worksheetId: 'ws-1' };

        const d = build_cell_history_delta({
            worksheet,
            sourceRow: 1,
            sourceColumn: 1,
            before: absent_overlay(),
            after: combined_overlay(history_value('x', runs), history_value('y'), link, null),
            persistedValue: history_value('y'),
            persistedHyperlink: null,
        })!;

        // Mutate every source object the delta was built from.
        link.target = 'https://evil.example/';
        worksheet.sheetName = 'Renamed';
        (runs.runs as { text: string }[])[0].text = 'mutated';

        expect(d.worksheet.sheetName).toBe('Sheet1');
        expect((d.hyperlink!.desired.content as { target: string }).target)
            .toBe('https://example.com/a');
        expect(d.value!.desired.content.runs?.runs[0]?.text).toBe('x');
        expect(Object.isFrozen(d)).toBe(true);
    });
});

describe('worksheet identity', () => {
    it('carries the full target, not just an index', () => {
        const d = delta({
            before: absent_overlay(),
            after: value_only_overlay(history_value('B'), history_value('A')),
            persistedValue: 'A',
        });
        expect(d!.worksheet).toEqual(SHEET);
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

describe('canonical_cell_history_delta', () => {
    const base = (text: string) => build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: 1,
        sourceColumn: 2,
        before: absent_overlay(),
        after: value_only_overlay(history_value(text), history_value('a')),
        persistedValue: history_value('a'),
        persistedHyperlink: null,
    })!;

    it('preserves the aliasing the byte estimate depends on', () => {
        // The same HistoryValue object stands in the transition and the overlay,
        // so the string exists once in memory. Rebuilding it twice would make a
        // holder charge it twice and refuse gestures that fit its bounds.
        const delta = canonical_cell_history_delta(base('b'));
        const overlay = delta.afterOverlay;
        if (overlay.kind !== 'present' || overlay.value.kind !== 'present') {
            throw new Error('fixture did not build a present value dimension');
        }
        expect(delta.value!.desired.content).toBe(overlay.value.value);
    });

    it('drops a property nobody declared', () => {
        const smuggled = { ...base('b'), extra: 'x'.repeat(100) } as unknown as CellHistoryDelta;
        expect(canonical_cell_history_delta(smuggled)).not.toHaveProperty('extra');
    });

    it('drops an undeclared property from a nested run', () => {
        const styled_value = history_value('b', {
            runs: [{ text: 'b', extra: 'x' } as unknown as { text: string }],
        } as never);
        const delta = build_cell_history_delta({
            worksheet: SHEET,
            sourceRow: 1,
            sourceColumn: 2,
            before: absent_overlay(),
            after: value_only_overlay(styled_value, history_value('a')),
            persistedValue: history_value('a'),
            persistedHyperlink: null,
        })!;
        expect(delta.value!.desired.content.runs!.runs[0]).not.toHaveProperty('extra');
    });

    it('reads an accessor-backed side once, so it cannot pair two answers', () => {
        // A side read twice could answer with two different objects, pairing one
        // answer's content with the other's overlay membership — a state the
        // caller never supplied, which replay would compare against or restore.
        const source = base('b');
        let reads = 0;
        const delta = {
            ...source,
            value: {
                mode: source.value!.mode,
                get expected() { reads += 1; return source.value!.expected; },
                desired: source.value!.desired,
            },
        } as unknown as CellHistoryDelta;

        canonical_cell_history_delta(delta);
        expect(reads).toBe(1);
    });

    it('copies runs into a plain array, ignoring a foreign species', () => {
        // A readonly array can be an Array subclass, and `map` honours its
        // Symbol.species — which would carry undeclared state into what a holder
        // retains and its estimator never charges.
        class Sneaky<T> extends Array<T> {
            smuggled = 'x'.repeat(100);
        }
        const sneaky = new Sneaky<{ text: string }>();
        sneaky.push({ text: 'b' });
        const runs = sneaky as unknown as readonly { text: string }[];
        const value = history_value('b', { runs } as never);
        const delta = canonical_cell_history_delta(build_cell_history_delta({
            worksheet: SHEET,
            sourceRow: 1,
            sourceColumn: 2,
            before: absent_overlay(),
            after: value_only_overlay(value, history_value('a')),
            persistedValue: history_value('a'),
            persistedHyperlink: null,
        })!);

        const canonical_runs = delta.value!.desired.content.runs!.runs;
        expect(canonical_runs).not.toBeInstanceOf(Sneaky);
        expect(canonical_runs).not.toHaveProperty('smuggled');
    });
});
describe('canonical delta ownership', () => {
    it('recognizes its own output and returns it unchanged', () => {
        // Re-canonicalizing would allocate a second copy of every string the delta
        // holds, so a gesture near the byte bound would hold both at once.
        const delta = build_cell_history_delta({
            worksheet: { sheetIndex: 0, sheetName: 'Data' },
            sourceRow: 0,
            sourceColumn: 0,
            before: absent_overlay(),
            after: value_only_overlay(history_value('v'), history_value('base')),
            persistedValue: history_value('base'),
            persistedHyperlink: null,
        });
        if (delta === undefined) throw new Error('fixture built a delta that moved nothing');

        expect(is_canonical_cell_delta(delta)).toBe(true);
        expect(canonical_cell_history_delta(delta)).toBe(delta);
        expect(is_canonical_cell_delta({ ...delta })).toBe(false);
    });

    it('shares one string across a delta that repeats it', () => {
        const text = 'repeated';
        const delta = canonical_cell_history_delta({
            ...(build_cell_history_delta({
                worksheet: { sheetIndex: 0, sheetName: text },
                sourceRow: 0,
                sourceColumn: 0,
                before: absent_overlay(),
                after: value_only_overlay(history_value(text), history_value(text)),
                persistedValue: history_value(text),
                persistedHyperlink: null,
            })!),
        });

        expect(delta.worksheet.sheetName).toBe(delta.value?.desired.content.text);
    });
});
describe('interned worksheet targets', () => {
    it('gives two deltas on one sheet the same target object', () => {
        // A delta is built one cell at a time, long before there is an action to
        // scope an owner to, so without a shared target every delta would detach its
        // own copy of the sheet name.
        const sheet: WorksheetTarget = { sheetIndex: 3, sheetName: 'Long', worksheetId: 'rId7' };
        const first = build_delta(sheet, 0);
        const second = build_delta(sheet, 1);

        expect(second.worksheet).toBe(first.worksheet);
        expect(second.worksheet.sheetName).toBe('Long');
    });

    it('does not conflate a named sheet with an unnamed one at the same index', () => {
        const named = build_delta({ sheetIndex: 0, sheetName: '' }, 0);
        const bare = build_delta({ sheetIndex: 0 }, 0);

        expect(named.worksheet).not.toBe(bare.worksheet);
        expect('sheetName' in bare.worksheet).toBe(false);
    });

    it('answers from the source object without touching a long identity', () => {
        // A wide gesture names one worksheet with one object, so the common case is
        // O(1) and never builds a composite key — which would be O(identity length)
        // per cell on an identity nothing bounds.
        const sheet: WorksheetTarget = { sheetIndex: 0, sheetName: 'n'.repeat(200_000) };
        const first = build_delta(sheet, 0);
        const second = build_delta(sheet, 1);

        expect(second.worksheet).toBe(first.worksheet);
    });

    it('does not intern an identity too long to key on cheaply', () => {
        // Two equal targets arriving as different objects stay separate rather than
        // paying O(identity length) to discover they match. Each copy is then
        // charged, so the estimate still follows the memory.
        const name = 'n'.repeat(200_000);
        const first = build_delta({ sheetIndex: 0, sheetName: name }, 0);
        const second = build_delta({ sheetIndex: 0, sheetName: name }, 1);

        expect(second.worksheet).not.toBe(first.worksheet);
        expect(second.worksheet.sheetName).toBe(name);
    });

    it('does not answer from the source memo after the caller mutated it', () => {
        // A caller's target is a mutable object — `readonly` is a compile-time claim
        // — and one renamed between two cells of a gesture would otherwise keep
        // answering with the first snapshot, so later deltas would replay against
        // the sheet it used to be.
        const sheet = { sheetIndex: 0, sheetName: 'Before' };
        const first = build_delta(sheet, 0);
        sheet.sheetName = 'After';
        const second = build_delta(sheet, 1);

        expect(first.worksheet.sheetName).toBe('Before');
        expect(second.worksheet.sheetName).toBe('After');
    });

    it('does not conflate a name with an id of the same text', () => {
        const named = build_delta({ sheetIndex: 0, sheetName: 'x' }, 0);
        const identified = build_delta({ sheetIndex: 0, worksheetId: 'x' }, 0);

        expect(named.worksheet).not.toBe(identified.worksheet);
    });
});

function build_delta(worksheet: WorksheetTarget, row: number): CellHistoryDelta {
    const delta = build_cell_history_delta({
        worksheet,
        sourceRow: row,
        sourceColumn: 0,
        before: absent_overlay(),
        after: value_only_overlay(history_value('v'), history_value('base')),
        persistedValue: history_value('base'),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return delta;
}
