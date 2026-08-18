import { describe, expect, it } from 'vitest';
import type { CellHyperlink, RichText } from '../cell-content';
import type { WorksheetTarget } from '../types';
import {
    sanitized_wire_cell_overlay_state,
    type HistoryReplayPrepared,
    type HistoryReplayPreparedCell,
} from '../history-replay-protocol';
import {
    absent_overlay,
    combined_overlay,
    history_value,
    hyperlink_only_overlay,
    overlay_states_equal,
    value_only_overlay,
    type CellOverlayState,
} from '../webview/history-cell-state-model';
import {
    cell_overlay_state_from_wire,
    history_replay_cell_input,
    prepared_cell_ordinals,
    prepared_overlays_match_store,
    read_state_from_prepared_replay,
    replay_cell_address,
    wire_overlay_from_cell_overlay_state,
} from '../webview/history-replay-wire-model';

const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/' };
const OTHER: CellHyperlink = { kind: 'internal', location: 'B2' };
const BOLD: RichText = { runs: [{ text: 'typed', style: { bold: true } }] };

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const SECOND: WorksheetTarget = { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' };

/** Every arm a real overlay can have, including the ones that differ only in intent. */
const OVERLAYS: readonly (readonly [string, CellOverlayState])[] = [
    ['absent', absent_overlay()],
    ['value only', value_only_overlay(history_value('typed'), history_value('disk'))],
    ['value only, styled', value_only_overlay(
        history_value('typed', BOLD), history_value('disk'),
    )],
    ['value only, base pending', value_only_overlay(
        history_value('typed'), history_value(''), true,
    )],
    ['link only', hyperlink_only_overlay(history_value('disk'), LINK, null)],
    ['link only, cleared', hyperlink_only_overlay(history_value('disk'), null, LINK)],
    ['combined', combined_overlay(
        history_value('typed'), history_value('disk'), LINK, null,
    )],
    ['combined, base pending', combined_overlay(
        history_value('typed'), history_value(''), OTHER, LINK, true,
    )],
];

function prepared_cell(
    overrides: Partial<HistoryReplayPreparedCell> = {},
): HistoryReplayPreparedCell {
    return {
        ordinal: 0,
        worksheet: SHEET,
        resolvedSheetIndex: 0,
        sourceRow: 3,
        sourceColumn: 4,
        overlay: wire_overlay_from_cell_overlay_state(absent_overlay()),
        persisted: { text: 'disk' },
        persistedHyperlink: null,
        ...overrides,
    };
}

function prepared(cells: readonly HistoryReplayPreparedCell[]): HistoryReplayPrepared {
    return {
        requestId: 'req-1',
        replayId: 'replay-1',
        leaseId: 'lease-1',
        expiresAt: 30_000,
        sourceGeneration: 7,
        focusSheetIndex: 0,
        focus: {
            worksheet: SHEET,
            sourceRowStart: 3,
            sourceRowEnd: 3,
            sourceColumnStart: 4,
            sourceColumnEnd: 4,
        },
        cells,
    };
}

describe('overlay round trip', () => {
    for (const [name, overlay] of OVERLAYS) {
        it(`round-trips ${name}`, () => {
            const wire = wire_overlay_from_cell_overlay_state(overlay);
            expect(overlay_states_equal(cell_overlay_state_from_wire(wire), overlay))
                .toBe(true);
        });

        it(`${name} survives the protocol's own sanitizer`, () => {
            // The two declarations of the overlay shape are only as honest as
            // this: what the webview emits must be what the host accepts.
            const wire = wire_overlay_from_cell_overlay_state(overlay);
            const parsed = sanitized_wire_cell_overlay_state(
                JSON.parse(JSON.stringify(wire)) as unknown,
            );
            expect(parsed).toBeDefined();
            expect(overlay_states_equal(
                cell_overlay_state_from_wire(parsed!), overlay,
            )).toBe(true);
        });
    }

    it('keeps link-only and combined apart, which is the whole point', () => {
        // Both serialize to {value: 'disk', base: 'disk', link} as an entry; only
        // the overlay distinguishes them, and they undo differently.
        const link_only = wire_overlay_from_cell_overlay_state(
            hyperlink_only_overlay(history_value('disk'), LINK, null),
        );
        const in_overlay = wire_overlay_from_cell_overlay_state(
            combined_overlay(history_value('disk'), history_value('disk'), LINK, null),
        );
        expect(link_only).not.toEqual(in_overlay);
        expect(overlay_states_equal(
            cell_overlay_state_from_wire(link_only),
            cell_overlay_state_from_wire(in_overlay),
        )).toBe(false);
    });

    it('preserves basePending, which history must never promote', () => {
        const wire = wire_overlay_from_cell_overlay_state(
            value_only_overlay(history_value('typed'), history_value(''), true),
        );
        const back = cell_overlay_state_from_wire(wire);
        expect(back.kind === 'present' && back.value.kind === 'present'
            && back.value.basePending).toBe(true);
    });
});

describe('replay_cell_address', () => {
    it('keys on the strongest identity a target carries', () => {
        // A sheet renamed or moved between two gestures an action merged: the
        // weaker fields disagree, and keying on the tuple would file one cell
        // as two, so a delta would miss its own prepared entry.
        expect(replay_cell_address({ sheetIndex: 0, sheetName: 'Old', worksheetId: 'rId1' }, 1, 2))
            .toBe(replay_cell_address({ sheetIndex: 4, sheetName: 'New', worksheetId: 'rId1' }, 1, 2));
        expect(replay_cell_address({ sheetIndex: 0, sheetName: 'Data' }, 1, 2))
            .toBe(replay_cell_address({ sheetIndex: 9, sheetName: 'Data' }, 1, 2));
        expect(replay_cell_address({ sheetIndex: 0 }, 1, 2))
            .not.toBe(replay_cell_address({ sheetIndex: 1 }, 1, 2));
    });

    it('separates cells and sheets', () => {
        expect(replay_cell_address(SHEET, 1, 2)).not.toBe(replay_cell_address(SHEET, 2, 1));
        expect(replay_cell_address(SHEET, 1, 2)).not.toBe(replay_cell_address(SECOND, 1, 2));
    });
});

describe('read_state_from_prepared_replay', () => {
    it('answers with the echoed overlay and the host persisted value', () => {
        const overlay = value_only_overlay(history_value('typed'), history_value('disk'));
        const read = read_state_from_prepared_replay(prepared([prepared_cell({
            overlay: wire_overlay_from_cell_overlay_state(overlay),
            persisted: { text: 'fresh' },
        })]));
        const state = read(SHEET, 3, 4);
        expect(state?.persisted.text).toBe('fresh');
        expect(overlay_states_equal(state!.overlay, overlay)).toBe(true);
    });

    it('answers undefined for a cell the request never listed', () => {
        const read = read_state_from_prepared_replay(prepared([prepared_cell()]));
        expect(read(SHEET, 99, 0)).toBeUndefined();
        expect(read(SECOND, 3, 4)).toBeUndefined();
    });

    it('serves two deltas on one cell from the single prepared entry', () => {
        // A paste overlapping its own source gives A->B then B->C; the cell has
        // one persisted side and one starting overlay however often it moves.
        const read = read_state_from_prepared_replay(prepared([prepared_cell()]));
        expect(read(SHEET, 3, 4)).toBeDefined();
        expect(read(SHEET, 3, 4)?.persisted.text).toBe('disk');
    });

    it('finds a cell through a weaker target than the one prepared', () => {
        const read = read_state_from_prepared_replay(prepared([prepared_cell()]));
        // Same worksheet id, different index and name.
        expect(read({ sheetIndex: 6, sheetName: 'Renamed', worksheetId: 'rId1' }, 3, 4))
            .toBeDefined();
    });

    it('carries styled persisted content', () => {
        const read = read_state_from_prepared_replay(prepared([prepared_cell({
            persisted: { text: 'typed', runs: BOLD },
        })]));
        expect(read(SHEET, 3, 4)?.persisted.runs).toEqual(BOLD);
    });
});

describe('prepared_cell_ordinals', () => {
    it('indexes prepared cells by address', () => {
        const cells = [
            prepared_cell({ ordinal: 0 }),
            prepared_cell({ ordinal: 1, sourceRow: 8, worksheet: SECOND, resolvedSheetIndex: 1 }),
        ];
        const index = prepared_cell_ordinals(prepared(cells));
        expect(index.get(replay_cell_address(SHEET, 3, 4))?.ordinal).toBe(0);
        expect(index.get(replay_cell_address(SECOND, 8, 4))?.ordinal).toBe(1);
        expect(index.size).toBe(2);
    });
});

describe('prepared_overlays_match_store', () => {
    const overlay = value_only_overlay(history_value('typed'), history_value('disk'));
    const snapshot = prepared([prepared_cell({
        overlay: wire_overlay_from_cell_overlay_state(overlay),
    })]);

    it('accepts a store that still agrees', () => {
        expect(prepared_overlays_match_store(snapshot, () => overlay)).toBe(true);
    });

    it('rejects a store that moved under the prepared snapshot', () => {
        expect(prepared_overlays_match_store(
            snapshot,
            () => value_only_overlay(history_value('other'), history_value('disk')),
        )).toBe(false);
    });

    it('rejects a formatting-only difference', () => {
        // Semantic comparison, the same one the planner and save path use.
        expect(prepared_overlays_match_store(
            snapshot,
            () => value_only_overlay(history_value('typed', {
                runs: [{ text: 'typed', style: { italic: true } }],
            }), history_value('disk')),
        )).toBe(false);
    });

    it('rejects an unreadable cell', () => {
        expect(prepared_overlays_match_store(snapshot, () => undefined)).toBe(false);
    });

    it('rejects a cell that left the overlay entirely', () => {
        expect(prepared_overlays_match_store(snapshot, () => absent_overlay())).toBe(false);
    });

    it('rejects an intent change that leaves the entry identical', () => {
        // The exact ambiguity the protocol carries the overlay to avoid.
        const link_snapshot = prepared([prepared_cell({
            overlay: wire_overlay_from_cell_overlay_state(
                hyperlink_only_overlay(history_value('disk'), LINK, null),
            ),
        })]);
        expect(prepared_overlays_match_store(
            link_snapshot,
            () => combined_overlay(history_value('disk'), history_value('disk'), LINK, null),
        )).toBe(false);
    });
});

describe('history_replay_cell_input', () => {
    it('builds one addressed input with its overlay on the wire', () => {
        const input = history_replay_cell_input(
            2, SECOND, 8, 1,
            hyperlink_only_overlay(history_value('disk'), LINK, null),
        );
        expect(input.ordinal).toBe(2);
        expect(input.sourceRow).toBe(8);
        expect(input.sourceColumn).toBe(1);
        expect(input.worksheet).toBe(SECOND);
        expect(input.overlay.kind).toBe('present');
    });
});
