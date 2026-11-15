import { describe, expect, it } from 'vitest';
import {
    MAX_PERSISTED_HIDDEN_ROWS,
    type FilterEntry,
    type SheetTransformState,
} from '../types';
import {
    columns_replay_target,
    columns_view_step,
    overtaken_transform_step,
    transform_replay_target,
    transform_slices_equal,
    transform_view_step,
    type ColumnsViewDelta,
    type TransformViewDelta,
} from '../webview/view-history-model';

const SHEET = { sheetIndex: 0, sheetName: 'Data' };
const SCHEMA = 'schema-1';
const NOW = { schema: SCHEMA, sourceRowCount: 100, protectedRows: 0 };

function filter(colIndex: number, value: string, enabled = true): FilterEntry {
    return { id: `f${colIndex}`, colIndex, operator: 'contains', value, caseSensitive: false, enabled };
}

function rules(partial: Partial<SheetTransformState> = {}): SheetTransformState {
    return { sort: [], filters: [], ...partial };
}

function transform_delta(
    before: SheetTransformState | undefined,
    after: SheetTransformState | undefined,
): TransformViewDelta {
    const step = transform_view_step(SHEET, SCHEMA, before, after);
    if (step?.delta.slice !== 'transform') throw new Error('expected a transform step');
    return step.delta;
}

describe('a transform gesture as a view step', () => {
    it('records a sort as the sort list before and after, and nothing else', () => {
        const before = rules({ filters: [filter(1, 'a')], hiddenRows: [4] });
        const after = { ...before, sort: [{ colIndex: 2, direction: 'desc' as const }] };
        const step = transform_view_step(SHEET, SCHEMA, before, after);
        expect(step).toEqual({
            label: 'Sort',
            delta: {
                worksheet: SHEET,
                slice: 'transform',
                schema: SCHEMA,
                sort: { before: [], after: [{ colIndex: 2, direction: 'desc' }] },
            },
        });
    });

    it('labels a changed sort Sort and a cleared one Clear sort', () => {
        const one = rules({ sort: [{ colIndex: 0, direction: 'asc' }] });
        const two = rules({ sort: [{ colIndex: 1, direction: 'asc' }] });
        expect(transform_view_step(SHEET, SCHEMA, one, two)?.label).toBe('Sort');
        expect(transform_view_step(SHEET, SCHEMA, one, rules())?.label).toBe('Clear sort');
    });

    it('labels filters by what happened to them', () => {
        const a = filter(0, 'a');
        const b = filter(1, 'b');
        const label = (before: FilterEntry[], after: FilterEntry[]) =>
            transform_view_step(SHEET, SCHEMA, rules({ filters: before }), rules({ filters: after }))?.label;
        expect(label([], [a])).toBe('Filter');
        expect(label([a], [filter(0, 'z')])).toBe('Filter');
        expect(label([a], [filter(0, 'a', false)])).toBe('Filter');
        expect(label([a, b], [b])).toBe('Clear filter');
        expect(label([a, b], [])).toBe('Clear filters');
        // One removed and another changed is a change, not a clear.
        expect(label([a, b], [filter(1, 'c')])).toBe('Filter');
    });

    it('records hidden rows as the rows hidden and shown, not the set', () => {
        const hide = transform_view_step(
            SHEET, SCHEMA, rules({ hiddenRows: [2, 9] }), rules({ hiddenRows: [2, 5, 9] }),
        );
        expect(hide?.label).toBe('Hide row');
        expect(hide?.delta).toMatchObject({ hiddenRows: { hidden: [5], shown: [] } });

        const many = transform_view_step(SHEET, SCHEMA, rules(), rules({ hiddenRows: [7, 3, 5] }));
        expect(many?.label).toBe('Hide 3 rows');
        expect(many?.delta).toMatchObject({ hiddenRows: { hidden: [3, 5, 7], shown: [] } });

        const unhide = transform_view_step(SHEET, SCHEMA, rules({ hiddenRows: [2, 9] }), rules());
        expect(unhide?.label).toBe('Unhide rows');
        expect(unhide?.delta).toMatchObject({ hiddenRows: { hidden: [], shown: [2, 9] } });
    });

    it('labels a gesture that changed two slices Change view', () => {
        const step = transform_view_step(
            SHEET,
            SCHEMA,
            rules(),
            rules({ sort: [{ colIndex: 0, direction: 'asc' }], filters: [filter(1, 'x')] }),
        );
        expect(step?.label).toBe('Change view');
        expect(Object.keys(step!.delta).sort()).toEqual(
            ['filters', 'schema', 'slice', 'sort', 'worksheet'],
        );
    });

    it('records nothing when no slice changed', () => {
        const same = rules({ sort: [{ colIndex: 0, direction: 'asc' }], hiddenRows: [1] });
        expect(transform_view_step(SHEET, SCHEMA, same, { ...same })).toBeUndefined();
        // Absent rules equal empty ones.
        expect(transform_view_step(SHEET, SCHEMA, undefined, rules())).toBeUndefined();
        expect(transform_view_step(SHEET, SCHEMA, rules({ hiddenRows: [] }), undefined)).toBeUndefined();
        // The compare window's toggle is not a slice.
        expect(transform_view_step(SHEET, SCHEMA, rules(), rules({ onlyChangedRows: true })))
            .toBeUndefined();
    });

    it('does not share arrays with the rules it was built from', () => {
        const after = rules({ sort: [{ colIndex: 0, direction: 'asc' }] });
        const step = transform_view_step(SHEET, SCHEMA, rules(), after);
        after.sort.push({ colIndex: 1, direction: 'desc' });
        expect(step?.delta).toMatchObject({ sort: { after: [{ colIndex: 0, direction: 'asc' }] } });
    });
});

describe('a sort or filter gesture a refresh overtook', () => {
    const baseline = rules({ filters: [filter(1, 'kept')] });
    const target = { ...baseline, sort: [{ colIndex: 0, direction: 'asc' as const }] };

    it('is the gesture when the refresh adopted its target', () => {
        expect(overtaken_transform_step(SHEET, SCHEMA, baseline, target, target)?.label).toBe('Sort');
    });

    it('is only the gesture when the refresh also carried something else', () => {
        const adopted = { ...target, filters: [filter(2, 'theirs')] };
        const step = overtaken_transform_step(SHEET, SCHEMA, baseline, target, adopted);
        expect(step?.label).toBe('Sort');
        expect(step?.delta).not.toHaveProperty('filters');
    });

    it('is nothing when the refresh did not carry the gesture', () => {
        expect(overtaken_transform_step(SHEET, SCHEMA, baseline, target, baseline)).toBeUndefined();
        const theirs = { ...baseline, filters: [filter(2, 'theirs')] };
        expect(overtaken_transform_step(SHEET, SCHEMA, baseline, target, theirs)).toBeUndefined();
        expect(overtaken_transform_step(SHEET, SCHEMA, baseline, target, undefined)).toBeUndefined();
    });

    it('is nothing when the gesture changed nothing', () => {
        expect(overtaken_transform_step(SHEET, SCHEMA, baseline, baseline, baseline)).toBeUndefined();
    });
});

describe('replaying a transform step', () => {
    const sorted = rules({ sort: [{ colIndex: 2, direction: 'desc' }] });
    const sort_delta = transform_delta(rules(), sorted);

    it('sets a list to the other side and leaves the other slices alone', () => {
        const live = { ...sorted, filters: [filter(0, 'x')], hiddenRows: [3], onlyChangedRows: true };
        const undo = transform_replay_target(sort_delta, 'undo', live, NOW);
        expect(undo).toEqual({
            target: {
                sort: [], filters: [filter(0, 'x')], hiddenRows: [3], onlyChangedRows: true, schema: SCHEMA,
            },
            skipped: [],
            changes: true,
        });
        const redo = transform_replay_target(sort_delta, 'redo', undo.target, NOW);
        expect(redo.target.sort).toEqual(sorted.sort);
        expect(redo.changes).toBe(true);
    });

    it('writes from the live state when it is not what the step left', () => {
        // Another window sorted differently since: the step's before still wins.
        const live = rules({ sort: [{ colIndex: 0, direction: 'asc' }] });
        const undo = transform_replay_target(sort_delta, 'undo', live, NOW);
        expect(undo.target.sort).toEqual([]);
        expect(undo.changes).toBe(true);
    });

    it('has nothing to do when the effect is already in place', () => {
        const undo = transform_replay_target(sort_delta, 'undo', rules(), NOW);
        expect(undo.changes).toBe(false);
        expect(undo.skipped).toEqual([]);
        const again = transform_replay_target(sort_delta, 'redo', sorted, NOW);
        expect(again.changes).toBe(false);
        // With no rules held at all.
        expect(transform_replay_target(sort_delta, 'undo', undefined, NOW).changes).toBe(false);
    });

    it('adds and removes only the rows the step hid or showed', () => {
        const hide = transform_delta(rules({ hiddenRows: [1] }), rules({ hiddenRows: [1, 5, 6] }));
        // Another window hid row 9 since.
        const live = rules({ hiddenRows: [1, 5, 6, 9] });
        expect(transform_replay_target(hide, 'undo', live, NOW).target.hiddenRows).toEqual([1, 9]);
        expect(transform_replay_target(hide, 'redo', rules({ hiddenRows: [9] }), NOW).target.hiddenRows)
            .toEqual([5, 6, 9]);

        const unhide = transform_delta(rules({ hiddenRows: [2, 4] }), rules());
        expect(transform_replay_target(unhide, 'undo', rules({ hiddenRows: [9] }), NOW).target.hiddenRows)
            .toEqual([2, 4, 9]);
        const shown = transform_replay_target(unhide, 'redo', rules({ hiddenRows: [2, 4] }), NOW);
        expect(shown.target).not.toHaveProperty('hiddenRows');
        expect(shown.changes).toBe(true);
    });

    it('skips sort and filters, and still applies hidden rows, when the columns changed', () => {
        const delta = transform_delta(
            rules({ hiddenRows: [3] }),
            rules({ sort: [{ colIndex: 0, direction: 'asc' }], filters: [filter(1, 'x')] }),
        );
        const live = rules({ sort: [{ colIndex: 1, direction: 'desc' }] });
        const undo = transform_replay_target(delta, 'undo', live, { ...NOW, schema: 'schema-2' });
        expect(undo.skipped).toEqual(['columns-changed']);
        expect(undo.target).toEqual({
            sort: [{ colIndex: 1, direction: 'desc' }], filters: [], hiddenRows: [3], schema: 'schema-2',
        });
        expect(undo.changes).toBe(true);

        const only_sort = transform_replay_target(sort_delta, 'undo', sorted, { ...NOW, schema: 'schema-2' });
        expect(only_sort.skipped).toEqual(['columns-changed']);
        expect(only_sort.changes).toBe(false);
    });

    it('keeps rows above the header row hidden and the header row shown', () => {
        const hide = transform_delta(rules(), rules({ hiddenRows: [1, 3, 7] }));
        // The header is now row 4 (source row 3): rows 0-2 are held hidden.
        const sheet = { ...NOW, protectedRows: 3, headerRow: 3 };
        const undo = transform_replay_target(hide, 'undo', rules({ hiddenRows: [0, 1, 2, 3, 7] }), sheet);
        expect(undo.target.hiddenRows).toEqual([0, 1, 2]);
        expect(undo.skipped).toEqual(['rows-above-header']);
        expect(undo.changes).toBe(true);

        const redo = transform_replay_target(hide, 'redo', rules({ hiddenRows: [0, 1, 2] }), sheet);
        expect(redo.target.hiddenRows).toEqual([0, 1, 2, 7]);
        expect(redo.skipped).toEqual(['header-row']);
    });

    it('leaves out rows past the end of the worksheet, by source rows', () => {
        const hide = transform_delta(rules(), rules({ hiddenRows: [4, 40] }));
        // A filter is on, so fewer rows are displayed; the bound is the source count.
        const live = rules({ filters: [filter(0, 'x')] });
        const redo = transform_replay_target(hide, 'redo', live, { ...NOW, sourceRowCount: 30 });
        expect(redo.target.hiddenRows).toEqual([4]);
        expect(redo.skipped).toEqual(['rows-gone']);
        const all_gone = transform_replay_target(hide, 'redo', live, { ...NOW, sourceRowCount: 2 });
        expect(all_gone.changes).toBe(false);
        expect(all_gone.skipped).toEqual(['rows-gone']);
    });

    it('hides none of the rows when the hidden set would pass the limit', () => {
        const hide = transform_delta(rules(), rules({ hiddenRows: [MAX_PERSISTED_HIDDEN_ROWS + 5] }));
        const live_rows = Array.from({ length: MAX_PERSISTED_HIDDEN_ROWS }, (_unused, row) => row);
        const redo = transform_replay_target(
            hide,
            'redo',
            rules({ hiddenRows: live_rows }),
            { ...NOW, sourceRowCount: MAX_PERSISTED_HIDDEN_ROWS + 10 },
        );
        expect(redo.skipped).toEqual(['too-many-hidden']);
        expect(redo.target.hiddenRows).toHaveLength(MAX_PERSISTED_HIDDEN_ROWS);
        expect(redo.changes).toBe(false);
    });

    it('stamps the target with the sheet schema it is replayed under', () => {
        const hide = transform_delta(rules(), rules({ hiddenRows: [2] }));
        const redo = transform_replay_target(hide, 'redo', rules({ schema: SCHEMA }), {
            ...NOW, schema: 'schema-2',
        });
        expect(redo.target.schema).toBe('schema-2');
        expect(redo.skipped).toEqual([]);
    });

    it('compares rules only in the slices the step names', () => {
        const other_filter = rules({ sort: sorted.sort, filters: [filter(0, 'x')] });
        expect(transform_slices_equal(sort_delta, sorted, other_filter)).toBe(true);
        expect(transform_slices_equal(sort_delta, sorted, rules())).toBe(false);
        expect(transform_slices_equal(sort_delta, rules(), undefined)).toBe(true);
    });
});

describe('hidden columns as a view step', () => {
    function delta(before: number[], after: number[]): ColumnsViewDelta {
        const step = columns_view_step(SHEET, SCHEMA, before, after);
        if (step?.delta.slice !== 'columns') throw new Error('expected a column step');
        return step.delta;
    }
    const sheet = { schema: SCHEMA, columnCount: 6 };

    it('records and labels what was hidden or shown', () => {
        expect(columns_view_step(SHEET, SCHEMA, [], [2])).toEqual({
            label: 'Hide column',
            delta: { worksheet: SHEET, slice: 'columns', schema: SCHEMA, hidden: [2], shown: [] },
        });
        expect(columns_view_step(SHEET, SCHEMA, [1], [1, 4, 3])?.label).toBe('Hide 2 columns');
        expect(columns_view_step(SHEET, SCHEMA, [1, 2], [2])?.label).toBe('Show column');
        expect(columns_view_step(SHEET, SCHEMA, [1, 2, 3], [])?.label).toBe('Show 3 columns');
        expect(columns_view_step(SHEET, SCHEMA, [1], [2])?.label).toBe('Change view');
        expect(columns_view_step(SHEET, SCHEMA, [2, 1], [1, 2])).toBeUndefined();
    });

    it('replays by member from the live set', () => {
        const hide = delta([1], [1, 3]);
        // Another window hid column 5 since.
        expect(columns_replay_target(hide, 'undo', [1, 3, 5], sheet))
            .toEqual({ hidden: [1, 5], skipped: [], changes: true });
        expect(columns_replay_target(hide, 'redo', [5], sheet))
            .toEqual({ hidden: [3, 5], skipped: [], changes: true });
        expect(columns_replay_target(hide, 'undo', [1], sheet).changes).toBe(false);
    });

    it('is skipped whole when the columns changed', () => {
        const hide = delta([], [3]);
        expect(columns_replay_target(hide, 'undo', [3], { schema: 'schema-2', columnCount: 6 }))
            .toEqual({ hidden: [3], skipped: ['columns-changed'], changes: false });
    });
});
