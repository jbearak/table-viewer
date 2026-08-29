import { describe, expect, it } from 'vitest';

import type { CellHyperlink } from '../cell-content';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    combined_overlay,
    history_value,
    hyperlink_only_overlay,
    value_only_overlay,
    type CellHistoryDelta,
    type CellOverlayState,
    type HistoryDirection,
} from '../webview/history-cell-state-model';
import { history_action, type HistoryChange } from '../webview/history-stack-model';
import {
    plan_history_replay,
    type CellReplayState,
    type ReadCellState,
    type ReplayPlan,
    type ReplayRefusal,
} from '../webview/history-replay-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Sheet1', worksheetId: 'ws-1' };
const OTHER: WorksheetTarget = { sheetIndex: 1, sheetName: 'Sheet2', worksheetId: 'ws-2' };

const LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/a' };
const OTHER_LINK: CellHyperlink = { kind: 'external', target: 'https://example.com/b' };

function value(text: string) {
    return history_value(text);
}

/** A delta for one cell, built the way the editing hooks build one. */
function delta(args: {
    readonly before: CellOverlayState;
    readonly after: CellOverlayState;
    readonly row?: number;
    readonly column?: number;
    readonly worksheet?: WorksheetTarget;
    readonly persisted?: string;
    readonly persistedLink?: CellHyperlink | null;
}): CellHistoryDelta {
    const built = build_cell_history_delta({
        worksheet: args.worksheet ?? SHEET,
        sourceRow: args.row ?? 0,
        sourceColumn: args.column ?? 0,
        before: args.before,
        after: args.after,
        persistedValue: value(args.persisted ?? 'disk'),
        persistedHyperlink: args.persistedLink ?? null,
    });
    if (!built) throw new Error('fixture described no change');
    return built;
}

function cell(delta: CellHistoryDelta): HistoryChange {
    return { kind: 'cell', delta };
}

/**
 * A reader over a fixed map of overlays, keyed `sheetIndex:row:col`. Every cell
 * reads 'disk' as its persisted text unless `persisted` says otherwise.
 */
function overlays(
    entries: Record<string, CellOverlayState | undefined>,
    seen?: string[],
    persisted: Record<string, string> = {},
): ReadCellState {
    return (worksheet, row, column) => {
        const key = `${worksheet.sheetIndex}:${row}:${column}`;
        seen?.push(key);
        const overlay = entries[key];
        if (overlay === undefined) return undefined;
        return { overlay, persisted: value(persisted[key] ?? 'disk') };
    };
}

function plan_of(
    changes: readonly HistoryChange[],
    direction: HistoryDirection,
    read: ReadCellState,
): ReplayPlan {
    const result = plan_history_replay(history_action('Edit', changes), direction, read);
    if (result.kind !== 'plan') {
        throw new Error(`expected a plan, refused with ${result.reason}`);
    }
    return result;
}

function refusal_of(
    changes: readonly HistoryChange[],
    direction: HistoryDirection,
    read: ReadCellState,
): ReplayRefusal {
    const result = plan_history_replay(history_action('Edit', changes), direction, read);
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    return result;
}

describe('planning an undo', () => {
    it('restores the entry the cell held before the edit', () => {
        const before = value_only_overlay(value('first'), value('disk'));
        const after = value_only_overlay(value('second'), value('disk'));
        const plan = plan_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': after }),
        );

        expect(plan.writes).toHaveLength(1);
        expect(plan.writes[0]?.key).toBe('0:0');
        expect(plan.writes[0]?.entry?.value).toBe('first');
        expect(plan.writes[0]?.entry?.base).toBe('disk');
    });

    it('removes the entry an edit created', () => {
        const after = value_only_overlay(value('typed'), value('disk'));
        const plan = plan_of(
            [cell(delta({ before: absent_overlay(), after }))],
            'undo',
            overlays({ '0:0:0': after }),
        );

        expect(plan.writes[0]?.entry).toBeUndefined();
    });

    it('restores the entry a discard removed', () => {
        // Discards are undoable, so the absent side is the one the cell holds now.
        const before = value_only_overlay(value('typed'), value('disk'));
        const plan = plan_of(
            [cell(delta({ before, after: absent_overlay() }))],
            'undo',
            overlays({ '0:0:0': absent_overlay() }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('typed');
    });

    it('walks a cell touched twice back through both states', () => {
        // A paste overlapping its own source gives A->B then B->C in one gesture.
        // Undo has to apply C->B before B->A, or the compare-and-swap on the first
        // delta looks for B and finds C.
        const a = value_only_overlay(value('A'), value('disk'));
        const b = value_only_overlay(value('B'), value('disk'));
        const c = value_only_overlay(value('C'), value('disk'));
        const plan = plan_of(
            [cell(delta({ before: a, after: b })), cell(delta({ before: b, after: c }))],
            'undo',
            overlays({ '0:0:0': c }),
        );

        expect(plan.writes.map((write) => write.entry?.value)).toEqual(['B', 'A']);
    });

    it('keeps a redo in recorded order', () => {
        const a = value_only_overlay(value('A'), value('disk'));
        const b = value_only_overlay(value('B'), value('disk'));
        const c = value_only_overlay(value('C'), value('disk'));
        const plan = plan_of(
            [cell(delta({ before: a, after: b })), cell(delta({ before: b, after: c }))],
            'redo',
            overlays({ '0:0:0': a }),
        );

        expect(plan.writes.map((write) => write.entry?.value)).toEqual(['B', 'C']);
    });
});

describe('the compare-and-swap', () => {
    it('refuses a cell whose overlay moved since the action', () => {
        const before = value_only_overlay(value('first'), value('disk'));
        const after = value_only_overlay(value('second'), value('disk'));
        const moved = value_only_overlay(value('somebody else'), value('disk'));
        const refusal = refusal_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': moved }),
        );

        expect(refusal.reason).toBe('conflict');
        expect(refusal.sourceRow).toBe(0);
    });

    it('refuses a cell the reader cannot see', () => {
        // Not the same as absent: an unopened worksheet answers nothing, and
        // treating that as absence would delete an entry never looked at.
        const before = value_only_overlay(value('first'), value('disk'));
        const after = value_only_overlay(value('second'), value('disk'));
        const refusal = refusal_of([cell(delta({ before, after }))], 'undo', overlays({}));

        expect(refusal.reason).toBe('unavailable');
    });

    it('refuses the whole gesture when one late cell has moved', () => {
        const before = value_only_overlay(value('A'), value('disk'));
        const after = value_only_overlay(value('B'), value('disk'));
        const moved = value_only_overlay(value('elsewhere'), value('disk'));
        const result = plan_history_replay(
            history_action('Paste', [
                cell(delta({ before, after, row: 0 })),
                cell(delta({ before, after, row: 1 })),
            ]),
            'undo',
            // Undo walks backwards, so row 1 is checked first and is fine; row 0
            // is the one that moved.
            overlays({ '0:0:0': moved, '0:1:0': after }),
        );

        expect(result.kind).toBe('refused');
    });

    it('stops reading at the first cell that refuses', () => {
        // The outcome is the same either way — nothing applied — so a wide paste
        // over a moved workbook must not walk a million cells to say so.
        const before = value_only_overlay(value('A'), value('disk'));
        const after = value_only_overlay(value('B'), value('disk'));
        const seen: string[] = [];
        refusal_of(
            [
                cell(delta({ before, after, row: 0 })),
                cell(delta({ before, after, row: 1 })),
                cell(delta({ before, after, row: 2 })),
            ],
            'undo',
            overlays({ '0:2:0': undefined, '0:1:0': after, '0:0:0': after }, seen),
        );

        expect(seen).toEqual(['0:2:0']);
    });

    it('does not compare content the record side never owned', () => {
        // An absent side's content is the cell's persisted text at record time,
        // which an intervening save may legitimately have moved. Comparing it
        // would refuse the undo for exactly the reason membership mode exists.
        const after = value_only_overlay(value('typed'), value('was disk'));
        const plan = plan_of(
            [cell(delta({ before: absent_overlay(), after, persisted: 'was disk' }))],
            'undo',
            overlays({ '0:0:0': after }),
        );

        expect(plan.writes[0]?.entry).toBeUndefined();
    });

    it('refuses when a cell that should be absent now has an overlay', () => {
        // Membership is checked even where content is not.
        const after = value_only_overlay(value('typed'), value('disk'));
        const refusal = refusal_of(
            [cell(delta({ before: absent_overlay(), after }))],
            'redo',
            overlays({ '0:0:0': value_only_overlay(value('other'), value('disk')) }),
        );

        expect(refusal.reason).toBe('conflict');
    });
});

describe('dimensions the action did not touch', () => {
    it('leaves a link a later gesture added exactly where it is', () => {
        // The value edit is undone; the hyperlink belongs to a different action
        // and the CAS deliberately did not object to it, because the dimension it
        // checked really was untouched.
        const before = value_only_overlay(value('first'), value('disk'));
        const after = value_only_overlay(value('second'), value('disk'));
        const now = combined_overlay(value('second'), value('disk'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': now }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('first');
        expect(plan.writes[0]?.entry?.link).toEqual(LINK);
        expect(plan.writes[0]?.entry?.baseLink).toBeNull();
    });

    it('keeps a link when undoing the edit that created the entry', () => {
        // The value dimension goes away, but the entry does not: a link-only
        // entry survives, anchored on the unedited text.
        const after = value_only_overlay(value('typed'), value('disk'));
        const now = combined_overlay(value('typed'), value('disk'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before: absent_overlay(), after }))],
            'undo',
            overlays({ '0:0:0': now }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('disk');
        expect(plan.writes[0]?.entry?.base).toBe('disk');
        expect(plan.writes[0]?.entry?.link).toEqual(LINK);
    });

    it('undoes a link change without disturbing a pending value edit', () => {
        const before = combined_overlay(value('typed'), value('disk'), null, null);
        const after = combined_overlay(value('typed'), value('disk'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': after }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('typed');
        expect(plan.writes[0]?.entry?.link).toBeNull();
    });

    it('removes the entry when the last dimension leaves it', () => {
        const before = hyperlink_only_overlay(value('disk'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before, after: absent_overlay() }))],
            'redo',
            overlays({ '0:0:0': before }),
        );

        expect(plan.writes[0]?.entry).toBeUndefined();
    });

    it('refuses rather than anchor a surviving link on a placeholder base', () => {
        // A base_pending entry's base is '' standing in for content nobody has
        // read yet. Promoting it to a link-only entry's unedited text would
        // fabricate content the user never saw, and admit a save against it.
        const after = value_only_overlay(value('typed'), value(''), true);
        const now: CellOverlayState = {
            kind: 'present',
            value: { kind: 'present', value: value('typed'), base: value(''), basePending: true },
            hyperlink: { kind: 'present', value: LINK, base: null },
        };
        const refusal = refusal_of(
            [cell(delta({ before: absent_overlay(), after }))],
            'undo',
            overlays({ '0:0:0': now }),
        );

        expect(refusal.reason).toBe('base-pending');
    });
});

describe('conflict metadata the swap must not ignore', () => {
    it('refuses when the base moved under an unchanged value', () => {
        // A recommit against a base that moved underneath is a real history
        // change: the base decides whether the cell reads as conflicted and
        // whether the save may be admitted. Comparing only the displayed value
        // would pass the swap and silently overwrite the later recommit.
        const before = value_only_overlay(value('B'), value('A'));
        const after = value_only_overlay(value('B'), value('C'));
        const moved = value_only_overlay(value('B'), value('D'));
        const refusal = refusal_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': moved }),
        );

        expect(refusal.reason).toBe('conflict');
    });

    it('refuses when basePending moved under an unchanged value', () => {
        const before = value_only_overlay(value('B'), value('A'));
        const after = value_only_overlay(value('B'), value('C'));
        const moved: CellOverlayState = {
            kind: 'present',
            value: { kind: 'present', value: value('B'), base: value('C'), basePending: true },
            hyperlink: { kind: 'untouched' },
        };
        const refusal = refusal_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': moved }),
        );

        expect(refusal.reason).toBe('conflict');
    });

    it('refuses when baseLink moved under an unchanged link', () => {
        const before = hyperlink_only_overlay(value('disk'), LINK, null);
        const after = hyperlink_only_overlay(value('disk'), LINK, OTHER_LINK);
        const moved = hyperlink_only_overlay(value('disk'), LINK, LINK);
        const refusal = refusal_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': moved }),
        );

        expect(refusal.reason).toBe('conflict');
    });

    it('refuses when a link-only anchor moved under an unchanged link', () => {
        // The anchor is reconstructed into the entry's value/base pair, so a move
        // of it changes the base the save is validated against.
        const before = hyperlink_only_overlay(value('A'), null, null);
        const after = hyperlink_only_overlay(value('A'), LINK, null);
        const moved = hyperlink_only_overlay(value('C'), LINK, null);
        const refusal = refusal_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': moved }),
        );

        expect(refusal.reason).toBe('conflict');
    });
});

describe('the anchor a link-only entry is restored on', () => {
    it('redoes a link attached to an unedited cell', () => {
        // Redo starts from an absent overlay, which has no anchor to offer — but
        // the action recorded one, and asking the cell instead would refuse a
        // replay whose answer was in hand all along.
        const after = hyperlink_only_overlay(value('A'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before: absent_overlay(), after, persisted: 'A' }))],
            'redo',
            overlays({ '0:0:0': absent_overlay() }, undefined, { '0:0:0': 'A' }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('A');
        expect(plan.writes[0]?.entry?.base).toBe('A');
        expect(plan.writes[0]?.entry?.link).toEqual(LINK);
    });

    it('undoes the removal of a link-only entry', () => {
        const before = hyperlink_only_overlay(value('A'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before, after: absent_overlay(), persisted: 'A' }))],
            'undo',
            overlays({ '0:0:0': absent_overlay() }, undefined, { '0:0:0': 'A' }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('A');
        expect(plan.writes[0]?.entry?.link).toEqual(LINK);
    });

    it('anchors on what the disk holds now, not what it held then', () => {
        // The recorded anchor was the disk content at record time, and a save may
        // legitimately have moved it since. Restoring it would not rewrite what
        // the user sees, but it would fabricate a conflict base the cell never
        // had — so the next save would report a conflict against content nobody
        // changed. Same rule membership mode follows, applied to the one field
        // the merge still has to fill in.
        const after = hyperlink_only_overlay(value('A'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before: absent_overlay(), after, persisted: 'A' }))],
            'redo',
            overlays({ '0:0:0': absent_overlay() }, undefined, { '0:0:0': 'C' }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('C');
        expect(plan.writes[0]?.entry?.base).toBe('C');
        expect(plan.writes[0]?.entry?.link).toEqual(LINK);
    });

    it('restores the recorded anchor rather than the one in place', () => {
        // Otherwise the undo is a silent no-op while history advances past it.
        const before = hyperlink_only_overlay(value('A'), LINK, null);
        const after = hyperlink_only_overlay(value('C'), LINK, null);
        const plan = plan_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': after }),
        );

        expect(plan.writes[0]?.entry?.value).toBe('A');
        expect(plan.writes[0]?.entry?.base).toBe('A');
    });
});

describe('addressing a cell across an action', () => {
    it('treats one worksheet id as one cell however the target was snapshotted', () => {
        // Two gestures merged into one action can name a sheet that was renamed
        // or moved between them. They resolve to the same worksheet, so the
        // second delta must see the first's planned state — keying on the whole
        // tuple would file them as two cells and refuse a consistent replay.
        const renamed: WorksheetTarget = { sheetIndex: 1, sheetName: 'New', worksheetId: 'ws-1' };
        const a = value_only_overlay(value('A'), value('disk'));
        const b = value_only_overlay(value('B'), value('disk'));
        const c = value_only_overlay(value('C'), value('disk'));
        const plan = plan_of(
            [
                cell(delta({ before: a, after: b, worksheet: SHEET })),
                cell(delta({ before: b, after: c, worksheet: renamed })),
            ],
            'undo',
            overlays({ '0:0:0': c, '1:0:0': c }),
        );

        expect(plan.writes.map((write) => write.entry?.value)).toEqual(['B', 'A']);
    });

    it('keeps two genuinely different sheets apart', () => {
        const a = value_only_overlay(value('A'), value('disk'));
        const b = value_only_overlay(value('B'), value('disk'));
        const plan = plan_of(
            [
                cell(delta({ before: a, after: b, worksheet: SHEET })),
                cell(delta({ before: a, after: b, worksheet: OTHER })),
            ],
            'undo',
            overlays({ '0:0:0': b, '1:0:0': b }),
        );

        expect(plan.writes.map((write) => write.entry?.value)).toEqual(['A', 'A']);
    });
});

describe('a plan across the workbook', () => {
    it('keeps every worksheet\'s writes, each addressed by its own target', () => {
        const before = value_only_overlay(value('A'), value('disk'));
        const after = value_only_overlay(value('B'), value('disk'));
        const plan = plan_of(
            [
                cell(delta({ before, after, worksheet: SHEET })),
                cell(delta({ before, after, worksheet: OTHER, row: 4 })),
            ],
            'redo',
            overlays({ '0:0:0': before, '1:4:0': before }),
        );

        expect(plan.writes.map((write) => write.worksheet.worksheetId)).toEqual(['ws-1', 'ws-2']);
        expect(plan.writes.map((write) => write.key)).toEqual(['0:0', '4:0']);
    });

    it('carries highlight changes through in replay order', () => {
        const before = value_only_overlay(value('A'), value('disk'));
        const after = value_only_overlay(value('B'), value('disk'));
        const highlight = (row: number): HistoryChange => ({
            kind: 'highlight',
            delta: {
                worksheet: SHEET,
                sourceRow: row,
                sourceColumn: 0,
                before: null,
                after: 'yellow',
            },
        });
        const plan = plan_of(
            [highlight(1), cell(delta({ before, after })), highlight(2)],
            'undo',
            overlays({ '0:0:0': after }),
        );

        expect(plan.highlights.map((delta) => delta.sourceRow)).toEqual([2, 1]);
    });

    it('plans nothing for an action of only highlights', () => {
        const plan = plan_of(
            [{
                kind: 'highlight',
                delta: {
                    worksheet: SHEET,
                    sourceRow: 0,
                    sourceColumn: 0,
                    before: 'yellow',
                    after: null,
                },
            }],
            'undo',
            overlays({}),
        );

        expect(plan.writes).toEqual([]);
        expect(plan.highlights).toHaveLength(1);
    });
});

describe('planning changes nothing', () => {
    it('reads overlays without writing any', () => {
        // The whole point of the split: a refusal must leave the session exactly
        // as it found it, including the cells it already checked.
        const before = value_only_overlay(value('A'), value('disk'));
        const after = value_only_overlay(value('B'), value('disk'));
        const state: Record<string, CellOverlayState | undefined> = {
            '0:0:0': after,
            '0:1:0': after,
        };
        const snapshot = { ...state };
        refusal_of(
            [
                cell(delta({ before, after, row: 0 })),
                cell(delta({ before, after, row: 1 })),
                cell(delta({ before, after, row: 2 })),
            ],
            'undo',
            overlays(state),
        );

        expect(state).toEqual(snapshot);
    });

    it('is deterministic: planning twice gives the same writes', () => {
        const before = value_only_overlay(value('A'), value('disk'));
        const after = value_only_overlay(value('B'), value('disk'));
        const changes = [cell(delta({ before, after }))];
        const read = overlays({ '0:0:0': after });

        expect(plan_of(changes, 'undo', read).writes)
            .toEqual(plan_of(changes, 'undo', read).writes);
    });
});

describe('links whose own dimension moved', () => {
    it('refuses when the pending link is not the one the action left', () => {
        const before = hyperlink_only_overlay(value('disk'), null, null);
        const after = hyperlink_only_overlay(value('disk'), LINK, null);
        const moved = hyperlink_only_overlay(value('disk'), OTHER_LINK, null);
        const refusal = refusal_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': moved }),
        );

        expect(refusal.reason).toBe('conflict');
    });

    it('restores a cleared link', () => {
        const before = hyperlink_only_overlay(value('disk'), LINK, LINK);
        const after = hyperlink_only_overlay(value('disk'), null, LINK);
        const plan = plan_of(
            [cell(delta({ before, after }))],
            'undo',
            overlays({ '0:0:0': after }),
        );

        expect(plan.writes[0]?.entry?.link).toEqual(LINK);
        expect(plan.writes[0]?.entry?.baseLink).toEqual(LINK);
    });
});

describe('latest observed file side', () => {
    it('survives replay independently of the historical overlay', () => {
        const before = absent_overlay();
        const after = value_only_overlay(value('pending'), value('original'));
        const plan = plan_of(
            [cell(delta({ before, after, persisted: 'original' }))],
            'redo',
            overlays({ '0:0:0': before }, undefined, { '0:0:0': 'current file' }),
        );

        expect(plan.writes[0]?.entry).toEqual({
            value: 'pending',
            base: 'original',
            observedBase: { value: 'current file' },
        });
    });

    it('does not overwrite a concurrent change to equal-value write intent', () => {
        const recorded = value_only_overlay(
            value('A'),
            value('A'),
            false,
            true,
        );
        const current = value_only_overlay(value('A'), value('A'));
        const result = plan_history_replay(
            history_action('Edit', [cell(delta({
                before: absent_overlay(),
                after: recorded,
                persisted: 'C',
            }))]),
            'undo',
            overlays({ '0:0:0': current }, undefined, { '0:0:0': 'C' }),
        );

        expect(result).toMatchObject({ kind: 'refused', reason: 'conflict' });
    });

    it('restores an older equal sparse entry over styled text without a false observation', () => {
        const before = value_only_overlay(value('A'), value('A'));
        const action = history_action('Discard pending edit', [cell(delta({
            before,
            after: absent_overlay(),
            persisted: 'A',
        }))]);
        const result = plan_history_replay(action, 'undo', () => ({
            overlay: absent_overlay(),
            persisted: history_value('A', {
                runs: [{ text: 'A', style: { bold: true } }],
            }),
        }));

        expect(result).toMatchObject({
            kind: 'plan',
            writes: [{ entry: { value: 'A', base: 'A' } }],
        });
        if (result.kind !== 'plan') throw new Error('expected replay plan');
        expect(result.writes[0]?.entry?.observedBase).toBeUndefined();
    });
});
