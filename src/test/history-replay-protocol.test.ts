import { describe, expect, it } from 'vitest';
import type { CellHyperlink, RichText } from '../cell-content';
import {
    MAX_HISTORY_ACTION_CELLS,
    MAX_HISTORY_ACTION_ENCODED_BYTES,
} from '../history-limits';
import {
    history_replay_proposal_digest,
    replay_request_requires_edit_session,
    sanitized_abandon_history_replay_request,
    sanitized_commit_history_replay_request,
    sanitized_prepare_history_replay_request,
    sanitized_wire_cell_overlay_state,
    sanitized_wire_history_replay_display_focus,
    sanitized_wire_history_replay_focus,
} from '../history-replay-protocol';

const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/' };
const BOLD: RichText = { runs: [{ text: 'typed', style: { bold: true } }] };

const SHEET = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };

const VALUE_ONLY = {
    kind: 'present',
    value: {
        kind: 'present',
        value: { text: 'typed' },
        base: { text: 'disk' },
        basePending: false,
    },
    hyperlink: { kind: 'untouched' },
};

const LINK_ONLY = {
    kind: 'present',
    value: { kind: 'untouched', anchor: { text: 'disk' } },
    hyperlink: { kind: 'present', value: LINK, base: null },
};

function prepare_request(overrides: Record<string, unknown> = {}): unknown {
    return {
        requestId: 'req-1',
        replayId: 'replay-1',
        cells: [{
            ordinal: 0,
            worksheet: SHEET,
            sourceRow: 3,
            sourceColumn: 4,
            overlay: VALUE_ONLY,
        }],
        highlights: [],
        focus: {
            worksheet: SHEET,
            sourceRowStart: 3,
            sourceRowEnd: 3,
            sourceColumnStart: 4,
            sourceColumnEnd: 4,
        },
        ...overrides,
    };
}

function commit_request(overrides: Record<string, unknown> = {}): unknown {
    return {
        requestId: 'req-1',
        replayId: 'replay-1',
        leaseId: 'lease-1',
        mutationId: 'mutation-1',
        cells: [{ ordinal: 0, entry: { value: 'typed', base: 'disk' } }],
        highlights: [],
        ...overrides,
    };
}

describe('sanitized_wire_cell_overlay_state', () => {
    it('accepts every arm a real overlay can have', () => {
        expect(sanitized_wire_cell_overlay_state({ kind: 'absent' }))
            .toEqual({ kind: 'absent' });
        expect(sanitized_wire_cell_overlay_state(VALUE_ONLY)?.kind).toBe('present');
        expect(sanitized_wire_cell_overlay_state(LINK_ONLY)?.kind).toBe('present');
        expect(sanitized_wire_cell_overlay_state({
            kind: 'present',
            value: {
                kind: 'present',
                value: { text: 'typed', runs: BOLD },
                base: { text: 'disk' },
                basePending: true,
            },
            hyperlink: { kind: 'present', value: null, base: LINK },
        })?.kind).toBe('present');
    });

    it('rejects a present overlay with neither dimension in it', () => {
        // The unrepresentable fourth arm: the save path would have nothing to do
        // with such an entry, so it must not arrive as a shape nothing expects.
        expect(sanitized_wire_cell_overlay_state({
            kind: 'present',
            value: { kind: 'untouched', anchor: { text: 'disk' } },
            hyperlink: { kind: 'untouched' },
        })).toBeUndefined();
    });

    it('rejects runs that do not describe their own text', () => {
        // Rejected, not dropped: a history value with its styling silently
        // removed is a different value, and replaying it would rewrite
        // formatting the user never touched.
        expect(sanitized_wire_cell_overlay_state({
            kind: 'present',
            value: {
                kind: 'present',
                value: { text: 'other', runs: BOLD },
                base: { text: 'disk' },
                basePending: false,
            },
            hyperlink: { kind: 'untouched' },
        })).toBeUndefined();
    });

    it('rejects a malformed hyperlink rather than dropping the dimension', () => {
        expect(sanitized_wire_cell_overlay_state({
            kind: 'present',
            value: { kind: 'untouched', anchor: { text: 'disk' } },
            hyperlink: { kind: 'present', value: { kind: 'external' }, base: null },
        })).toBeUndefined();
    });

    it('rejects a missing basePending, which is load-bearing', () => {
        expect(sanitized_wire_cell_overlay_state({
            kind: 'present',
            value: { kind: 'present', value: { text: 'a' }, base: { text: 'b' } },
            hyperlink: { kind: 'untouched' },
        })).toBeUndefined();
    });

    it('owns what it returns', () => {
        const parsed = sanitized_wire_cell_overlay_state(VALUE_ONLY);
        expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('rejects a non-record', () => {
        for (const bad of [null, undefined, 'absent', 7, []]) {
            expect(sanitized_wire_cell_overlay_state(bad)).toBeUndefined();
        }
    });
});

describe('sanitized_wire_history_replay_focus', () => {
    it('accepts an inclusive region', () => {
        const focus = sanitized_wire_history_replay_focus({
            worksheet: SHEET,
            sourceRowStart: 2,
            sourceRowEnd: 5,
            sourceColumnStart: 1,
            sourceColumnEnd: 1,
        });
        expect(focus?.sourceRowEnd).toBe(5);
    });

    it('rejects an inverted region', () => {
        expect(sanitized_wire_history_replay_focus({
            worksheet: SHEET,
            sourceRowStart: 5,
            sourceRowEnd: 2,
            sourceColumnStart: 1,
            sourceColumnEnd: 1,
        })).toBeUndefined();
    });

    it('rejects negative and non-integer coordinates', () => {
        for (const bad of [-1, 1.5, Number.NaN, '3']) {
            expect(sanitized_wire_history_replay_focus({
                worksheet: SHEET,
                sourceRowStart: bad,
                sourceRowEnd: 9,
                sourceColumnStart: 0,
                sourceColumnEnd: 0,
            })).toBeUndefined();
        }
    });
});

describe('sanitized_wire_history_replay_display_focus', () => {
    it('accepts an inclusive display-row interval with its mapping generation', () => {
        const focus = sanitized_wire_history_replay_display_focus({
            displayRowStart: 4,
            displayRowEnd: 9,
            mappingGeneration: 3,
        });
        expect(focus).toEqual({ displayRowStart: 4, displayRowEnd: 9, mappingGeneration: 3 });
        expect(Object.isFrozen(focus)).toBe(true);
    });

    it('distinguishes "nowhere visible" from "malformed"', () => {
        // `null` is an ANSWER: every row the replay touched is filtered out of the
        // view, which is a successful replay with no truthful cursor target. A
        // caller that conflated it with `undefined` would report a protocol fault
        // for an ordinary filtered workbook.
        expect(sanitized_wire_history_replay_display_focus(null)).toBeNull();
        expect(sanitized_wire_history_replay_display_focus(undefined)).toBeUndefined();
        expect(sanitized_wire_history_replay_display_focus('null')).toBeUndefined();
    });

    it('rejects an inverted interval', () => {
        expect(sanitized_wire_history_replay_display_focus({
            displayRowStart: 9,
            displayRowEnd: 4,
            mappingGeneration: 3,
        })).toBeUndefined();
    });

    it('rejects rows and generations that cannot index anything', () => {
        for (const bad of [-1, 1.5, Number.NaN, '3', null]) {
            expect(sanitized_wire_history_replay_display_focus({
                displayRowStart: bad,
                displayRowEnd: 9,
                mappingGeneration: 3,
            })).toBeUndefined();
            expect(sanitized_wire_history_replay_display_focus({
                displayRowStart: 0,
                displayRowEnd: 9,
                mappingGeneration: bad,
            })).toBeUndefined();
        }
    });
});

describe('sanitized_prepare_history_replay_request', () => {
    it('accepts a well-formed request and owns it', () => {
        const parsed = sanitized_prepare_history_replay_request(prepare_request());
        expect(parsed?.requestId).toBe('req-1');
        expect(parsed?.cells).toHaveLength(1);
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(Object.isFrozen(parsed?.cells)).toBe(true);
        expect(Object.isFrozen(parsed?.cells[0])).toBe(true);
    });

    it('rejects an over-count request before walking or owning its sparse cells', () => {
        expect(sanitized_prepare_history_replay_request(prepare_request({
            cells: new Array(MAX_HISTORY_ACTION_CELLS + 1),
        }))).toBeUndefined();
    });

    it('rejects aggregate replay bytes before cloning repeated large overlays', () => {
        const shared = 'x'.repeat(2 * 1024 * 1024);
        const count = Math.ceil(MAX_HISTORY_ACTION_ENCODED_BYTES / shared.length) + 1;
        expect(count).toBeLessThanOrEqual(MAX_HISTORY_ACTION_CELLS);
        const cells = Array.from({ length: count }, (_, ordinal) => ({
            ordinal,
            worksheet: SHEET,
            sourceRow: ordinal,
            sourceColumn: 0,
            overlay: {
                kind: 'present',
                value: {
                    kind: 'present',
                    value: { text: shared },
                    base: { text: 'disk' },
                    basePending: false,
                },
                hyperlink: { kind: 'untouched' },
            },
        }));
        expect(sanitized_prepare_history_replay_request(prepare_request({ cells })))
            .toBeUndefined();
    });

    it('a caller mutating its own input cannot reach the parsed request', () => {
        const input = prepare_request() as {
            cells: { sourceRow: number; overlay: unknown }[];
        };
        const parsed = sanitized_prepare_history_replay_request(input);
        input.cells[0].sourceRow = 99;
        input.cells.push({ sourceRow: 1, overlay: VALUE_ONLY });
        expect(parsed?.cells).toHaveLength(1);
        expect(parsed?.cells[0].sourceRow).toBe(3);
    });

    it('accepts an empty cell list when highlights carry the replay', () => {
        // A highlight-only gesture writes no pending-edit state, so it has no
        // cells — and needs no edit session, which the host decides from this very
        // list rather than from anything the renderer claims.
        const parsed = sanitized_prepare_history_replay_request(prepare_request({
            cells: [],
            highlights: [{
                ordinal: 0,
                worksheet: SHEET,
                sourceRow: 1,
                sourceColumn: 2,
                expected: null,
                desired: 'yellow',
            }],
        }));
        expect(parsed?.cells).toEqual([]);
        expect(parsed?.highlights).toHaveLength(1);
    });

    it('rejects a request with no cell, highlight, or structural arm', () => {
        // Nothing to prepare is not a replay; it would take a lease authorizing
        // nothing.
        expect(sanitized_prepare_history_replay_request(
            prepare_request({ cells: [], highlights: [] }),
        )).toBeUndefined();
    });

    it('owns a complete structural transition as a leased replay arm', () => {
        const empty = {
            formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [],
        };
        const desired = {
            ...empty,
            conflicts: [{
                reason: 'ambiguousColumns',
                pendingRowIds: [],
                tailRemovalIds: [],
            }],
        };
        const parsed = sanitized_prepare_history_replay_request(prepare_request({
            cells: [],
            highlights: [],
            structures: [{ ordinal: 0, worksheet: SHEET, expected: empty, desired }],
        }));
        expect(parsed?.structures).toEqual([{
            ordinal: 0,
            worksheet: SHEET,
            expected: empty,
            desired,
        }]);
        expect(Object.isFrozen(parsed?.structures?.[0].desired)).toBe(true);
        expect(replay_request_requires_edit_session(parsed!)).toBe(false);
    });

    it('requires an edit session only when the replay writes cells', () => {
        const parsed = sanitized_prepare_history_replay_request(prepare_request());
        expect(replay_request_requires_edit_session(parsed!)).toBe(true);
    });

    it('owns bounded unique row-admission correlations', () => {
        const parsed = sanitized_prepare_history_replay_request(prepare_request({
            rowAdmissionRequestIds: ['restore-1', 'restore-2'],
        }));
        expect(parsed?.rowAdmissionRequestIds).toEqual(['restore-1', 'restore-2']);
        expect(Object.isFrozen(parsed?.rowAdmissionRequestIds)).toBe(true);
        expect(sanitized_prepare_history_replay_request(prepare_request({
            rowAdmissionRequestIds: ['restore-1', 'restore-1'],
        }))).toBeUndefined();
        expect(sanitized_prepare_history_replay_request(prepare_request({
            rowAdmissionRequestIds: ['x'.repeat(257)],
        }))).toBeUndefined();
    });

    it('rejects sparse ordinals', () => {
        // Denseness is what lets a commit address cells by ordinal alone.
        expect(sanitized_prepare_history_replay_request(prepare_request({
            cells: [{
                ordinal: 1,
                worksheet: SHEET,
                sourceRow: 0,
                sourceColumn: 0,
                overlay: VALUE_ONLY,
            }],
        }))).toBeUndefined();
    });

    it('rejects duplicate ordinals', () => {
        const cell = {
            ordinal: 0,
            worksheet: SHEET,
            sourceRow: 0,
            sourceColumn: 0,
            overlay: VALUE_ONLY,
        };
        expect(sanitized_prepare_history_replay_request(
            prepare_request({ cells: [cell, { ...cell }] }),
        )).toBeUndefined();
    });

    it('ignores a direction, which the wire deliberately does not carry', () => {
        // Undo and redo are already resolved into each delta's expected/desired
        // sides, so a direction on the wire would be a second account of the same
        // intent. An old renderer that still sends one is not rejected for it.
        const parsed = sanitized_prepare_history_replay_request(
            prepare_request({ direction: 'sideways' }),
        );
        expect(parsed).not.toBeUndefined();
        expect(parsed).not.toHaveProperty('direction');
    });

    it('rejects an empty correlation id', () => {
        expect(sanitized_prepare_history_replay_request(
            prepare_request({ requestId: '' }),
        )).toBeUndefined();
        expect(sanitized_prepare_history_replay_request(
            prepare_request({ replayId: '' }),
        )).toBeUndefined();
    });

    it('accepts highlight transitions and rejects an unknown colour', () => {
        const highlight = {
            ordinal: 0,
            worksheet: SHEET,
            sourceRow: 1,
            sourceColumn: 2,
            expected: null,
            desired: 'yellow',
        };
        expect(sanitized_prepare_history_replay_request(
            prepare_request({ highlights: [highlight] }),
        )?.highlights[0].desired).toBe('yellow');
        expect(sanitized_prepare_history_replay_request(
            prepare_request({ highlights: [{ ...highlight, desired: 'chartreuse' }] }),
        )).toBeUndefined();
    });

    it('rejects a bad worksheet target', () => {
        expect(sanitized_prepare_history_replay_request(prepare_request({
            cells: [{
                ordinal: 0,
                worksheet: { sheetIndex: -1 },
                sourceRow: 0,
                sourceColumn: 0,
                overlay: VALUE_ONLY,
            }],
        }))).toBeUndefined();
    });
});

describe('sanitized_commit_history_replay_request', () => {
    it('accepts writes and removals', () => {
        const parsed = sanitized_commit_history_replay_request(commit_request({
            cells: [
                { ordinal: 0, entry: { value: 'typed', base: 'disk' } },
                { ordinal: 1, entry: null },
            ],
        }));
        const first = parsed?.cells[0].entry;
        expect(typeof first === 'object' && first !== null ? first.value : undefined).toBe('typed');
        expect(parsed?.cells[1].entry).toBeNull();
        expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('rejects over-count and aggregate-byte commit proposals before ownership', () => {
        expect(sanitized_commit_history_replay_request(commit_request({
            cells: new Array(MAX_HISTORY_ACTION_CELLS + 1),
        }))).toBeUndefined();

        const shared = 'x'.repeat(2 * 1024 * 1024);
        const count = Math.ceil(MAX_HISTORY_ACTION_ENCODED_BYTES / shared.length) + 1;
        expect(count).toBeLessThanOrEqual(MAX_HISTORY_ACTION_CELLS);
        expect(sanitized_commit_history_replay_request(commit_request({
            cells: Array.from({ length: count }, (_, ordinal) => ({
                ordinal,
                entry: { value: shared, base: 'disk' },
            })),
        }))).toBeUndefined();
    });

    it('requires a lease and a mutation id', () => {
        expect(sanitized_commit_history_replay_request(
            commit_request({ leaseId: '' }),
        )).toBeUndefined();
        expect(sanitized_commit_history_replay_request(
            commit_request({ mutationId: undefined }),
        )).toBeUndefined();
    });

    it('carries no coordinates at all', () => {
        // The whole point of ordinals: a commit cannot name a cell that
        // preparation never verified, because it cannot name a cell.
        const parsed = sanitized_commit_history_replay_request(commit_request());
        const write = parsed?.cells[0] as Record<string, unknown> | undefined;
        expect(write).toBeDefined();
        expect(Object.keys(write!).sort()).toEqual(['entry', 'ordinal']);
    });

    it('a highlight write names an ordinal and nothing else', () => {
        // What to write is already in the prepared request's `desired`, which
        // the host verified; restating it would be choosing an unchecked colour.
        const parsed = sanitized_commit_history_replay_request(commit_request({
            highlights: [{ ordinal: 0, desired: 'pink' }],
        }));
        expect(Object.keys(parsed!.highlights[0])).toEqual(['ordinal']);
    });

    it('a structural write names only the leased ordinal', () => {
        const parsed = sanitized_commit_history_replay_request(commit_request({
            structures: [{ ordinal: 0, desired: { appendedRows: ['unchecked'] } }],
        }));
        expect(parsed?.structures).toEqual([{ ordinal: 0 }]);
    });

    it('rejects a malformed entry', () => {
        expect(sanitized_commit_history_replay_request(
            commit_request({ cells: [{ ordinal: 0, entry: { value: 1, base: 'a' } }] }),
        )).toBeUndefined();
    });

    it('refuses an entry whose runs do not match, rather than stripping them', () => {
        // The save path drops a bad run side and keeps the entry, because the
        // plain projection is still what the user committed. A replay must not:
        // restoring the user's styled text unstyled is a wrong undo.
        expect(sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: { value: 'typed', base: 'disk', valueRuns: { runs: [{ text: 'other' }] } },
            }],
        }))).toBeUndefined();
    });

    it('refuses a half-specified link dimension', () => {
        // A link change with no recorded base could never be conflict-checked.
        expect(sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'a', base: 'a', link: LINK } }],
        }))).toBeUndefined();
    });

    it('copies the entry rather than retaining the caller\'s object', () => {
        const entry = { value: 'typed', base: 'disk' };
        const parsed = sanitized_commit_history_replay_request(
            commit_request({ cells: [{ ordinal: 0, entry }] }),
        );
        expect(parsed?.cells[0].entry).not.toBe(entry);
        const copied = parsed?.cells[0].entry;
        expect(typeof copied === 'object' && copied !== null ? copied.value : undefined)
            .toBe('typed');
    });

    it('retains move and edit-order metadata while copying an entry', () => {
        const entry = {
            value: 'typed',
            base: 'disk',
            movedFrom: { row: 1, col: 2, order: 7 },
            valueEditOrder: 8,
        };
        const parsed = sanitized_commit_history_replay_request(
            commit_request({ cells: [{ ordinal: 0, entry }] }),
        );

        expect(parsed?.cells[0].entry).toEqual(entry);
        expect(parsed?.cells[0].entry).not.toBe(entry);
    });

    it('rejects sparse and duplicate ordinals', () => {
        expect(sanitized_commit_history_replay_request(
            commit_request({ cells: [{ ordinal: 4, entry: null }] }),
        )).toBeUndefined();
        expect(sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: null }, { ordinal: 0, entry: null }],
        }))).toBeUndefined();
    });

    it('accepts a legacy bare string, the one durable form with an unobserved base', () => {
        const parsed = sanitized_commit_history_replay_request(
            commit_request({ cells: [{ ordinal: 0, entry: 'typed' }] }),
        );
        expect(parsed?.cells[0].entry).toBe('typed');
    });

    it('rejects an entry that is neither a string, a record, nor null', () => {
        for (const entry of [7, true, [], undefined]) {
            expect(sanitized_commit_history_replay_request(
                commit_request({ cells: [{ ordinal: 0, entry }] }),
            )).toBeUndefined();
        }
    });

    it('accepts a commit that writes nothing, which a pure highlight action is', () => {
        expect(sanitized_commit_history_replay_request(
            commit_request({ cells: [], highlights: [{ ordinal: 0 }] }),
        )?.cells).toEqual([]);
    });
});

describe('sanitized_abandon_history_replay_request', () => {
    it('needs the full lease identity', () => {
        expect(sanitized_abandon_history_replay_request({
            requestId: 'req-1', replayId: 'replay-1', leaseId: 'lease-1',
        })?.leaseId).toBe('lease-1');
        expect(sanitized_abandon_history_replay_request({
            requestId: 'req-1', replayId: 'replay-1',
        })).toBeUndefined();
    });
});

describe('history_replay_proposal_digest', () => {
    it('agrees across two encodings of one proposal', () => {
        const forward = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: null }, { ordinal: 1, entry: null }],
        }));
        const reversed = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 1, entry: null }, { ordinal: 0, entry: null }],
        }));
        expect(history_replay_proposal_digest(forward!))
            .toBe(history_replay_proposal_digest(reversed!));
    });

    it('separates proposals that would write different things', () => {
        const first = sanitized_commit_history_replay_request(commit_request());
        const second = sanitized_commit_history_replay_request(
            commit_request({ cells: [{ ordinal: 0, entry: null }] }),
        );
        expect(history_replay_proposal_digest(first!))
            .not.toBe(history_replay_proposal_digest(second!));
    });

    it('separates a formatting-only difference', () => {
        const plain = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'typed', base: 'disk' } }],
        }));
        const styled = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: { value: 'typed', base: 'disk', valueRuns: BOLD },
            }],
        }));
        expect(history_replay_proposal_digest(plain!))
            .not.toBe(history_replay_proposal_digest(styled!));
    });

    it('separates a link left alone from a link cleared', () => {
        // Absent and `null` are different instructions on the link dimension —
        // "leave it" versus "clear it" (see `CsvDirtyEntry`) — so they must not
        // digest alike, or a link-only difference reads as a duplicate commit.
        const untouched = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'typed', base: 'disk' } }],
        }));
        const cleared = sanitized_commit_history_replay_request(commit_request({
            // Both link keys, because the strict guard takes the dimension as a
            // pair — that is what "clear it" looks like on the wire.
            cells: [{
                ordinal: 0,
                entry: { value: 'typed', base: 'disk', link: null, baseLink: null },
            }],
        }));
        expect(untouched).toBeDefined();
        expect(cleared).toBeDefined();
        expect(history_replay_proposal_digest(untouched!))
            .not.toBe(history_replay_proposal_digest(cleared!));
    });

    it('separates different observed file sides', () => {
        const first = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: {
                    value: 'pending',
                    base: 'original',
                    observedBase: { value: 'current-a' },
                },
            }],
        }));
        const second = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: {
                    value: 'pending',
                    base: 'original',
                    observedBase: { value: 'current-b' },
                },
            }],
        }));
        expect(history_replay_proposal_digest(first!))
            .not.toBe(history_replay_proposal_digest(second!));
    });

    it('separates inferred value intent from an explicit equal-value write', () => {
        const inferred = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'A', base: 'A' } }],
        }));
        const explicit = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: { value: 'A', base: 'A', writeValue: true },
            }],
        }));
        expect(history_replay_proposal_digest(inferred!))
            .not.toBe(history_replay_proposal_digest(explicit!));
    });

    it('separates retained value membership from both save-write intents', () => {
        const inferred = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'A', base: 'A' } }],
        }));
        const retained = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: { value: 'A', base: 'A', retainValue: true },
            }],
        }));
        expect(retained?.cells[0]?.entry).toMatchObject({ retainValue: true });
        expect(history_replay_proposal_digest(inferred!))
            .not.toBe(history_replay_proposal_digest(retained!));
    });

    it('separates known plain formatting from legacy-unknown formatting', () => {
        const unknown = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'B', base: 'A' } }],
        }));
        const known = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: { value: 'B', base: 'A', formattingKnown: true },
            }],
        }));
        expect(known?.cells[0]?.entry).toMatchObject({ formattingKnown: true });
        expect(history_replay_proposal_digest(unknown!))
            .not.toBe(history_replay_proposal_digest(known!));
    });

    it('separates move provenance and formula edit orders', () => {
        const plain = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'typed', base: 'disk' } }],
        }));
        const moved = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: {
                    value: 'typed',
                    base: 'disk',
                    movedFrom: { row: 1, col: 2, order: 7 },
                },
            }],
        }));
        const ordered = sanitized_commit_history_replay_request(commit_request({
            cells: [{
                ordinal: 0,
                entry: { value: 'typed', base: 'disk', valueEditOrder: 8 },
            }],
        }));

        expect(history_replay_proposal_digest(plain!))
            .not.toBe(history_replay_proposal_digest(moved!));
        expect(history_replay_proposal_digest(plain!))
            .not.toBe(history_replay_proposal_digest(ordered!));
        expect(history_replay_proposal_digest(moved!))
            .not.toBe(history_replay_proposal_digest(ordered!));
    });

    it('separates move proposals that differ only by stable row identity', () => {
        const proposal = (pendingRowId: string) =>
            sanitized_commit_history_replay_request(commit_request({
                cells: [{
                    ordinal: 0,
                    entry: {
                        value: 'typed',
                        base: 'disk',
                        movedFrom: {
                            row: 1,
                            col: 2,
                            order: 7,
                            rowIdentity: { kind: 'pending', pendingRowId },
                            previous: [{
                                sourceRow: 1,
                                sourceCol: 2,
                                destinationRow: 3,
                                destinationCol: 4,
                                order: 6,
                                sourceRowIdentity: { kind: 'pending', pendingRowId },
                                destinationRowIdentity: { kind: 'source', sourceRow: 3 },
                            }],
                        },
                    },
                }],
            }));
        expect(history_replay_proposal_digest(proposal('pending-a')!))
            .not.toBe(history_replay_proposal_digest(proposal('pending-b')!));
    });

    it('separates a legacy string from an entry whose value equals it', () => {
        // The two differ only in whether the base was observed, which is exactly
        // the fact a proposal must not blur.
        const legacy = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: 'typed' }],
        }));
        const full = sanitized_commit_history_replay_request(commit_request({
            cells: [{ ordinal: 0, entry: { value: 'typed', base: '' } }],
        }));
        expect(history_replay_proposal_digest(legacy!))
            .not.toBe(history_replay_proposal_digest(full!));
    });

    it('separates two mutation ids over the same writes', () => {
        const first = sanitized_commit_history_replay_request(commit_request());
        const second = sanitized_commit_history_replay_request(
            commit_request({ mutationId: 'mutation-2' }),
        );
        expect(history_replay_proposal_digest(first!))
            .not.toBe(history_replay_proposal_digest(second!));
    });
});
