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
    type ReadCellOverlay,
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

/** A reader over a fixed map of overlays, keyed `sheetIndex:row:col`. */
function overlays(
    entries: Record<string, CellOverlayState | undefined>,
    seen?: string[],
): ReadCellOverlay {
    return (worksheet, row, column) => {
        const key = `${worksheet.sheetIndex}:${row}:${column}`;
        seen?.push(key);
        return entries[key];
    };
}

function plan_of(
    changes: readonly HistoryChange[],
    direction: HistoryDirection,
    read: ReadCellOverlay,
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
    read: ReadCellOverlay,
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
