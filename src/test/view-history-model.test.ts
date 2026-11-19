import { describe, expect, it } from 'vitest';
import {
    MAX_PERSISTED_HIDDEN_ROWS,
    excel_header_side,
    type ExcelHeaderChange,
    type FilterEntry,
    type SheetTransformState,
} from '../types';
import {
    auto_fit_after_width_replay,
    column_widths_label,
    column_widths_replay_target,
    column_widths_view_step,
    columns_replay_target,
    columns_view_step,
    row_fit_view_step,
    row_heights_replay_target,
    row_heights_view_step,
    header_replay_target,
    header_step_label,
    header_view_delta,
    overtaken_transform_step,
    transform_replay_target,
    transform_slices_equal,
    transform_view_step,
    type ColumnWidthsViewDelta,
    type ColumnsViewDelta,
    type HeaderViewDelta,
    type RowHeightsViewDelta,
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

describe('a column-width write as a view step', () => {
    function width_delta(
        columns: ColumnWidthsViewDelta['columns'],
        auto_fit?: 'on' | 'off',
    ): ColumnWidthsViewDelta {
        const step = column_widths_view_step(SHEET, columns, auto_fit);
        if (step?.delta.slice !== 'columnWidths') throw new Error('expected a width step');
        return step.delta;
    }

    it('records what the host says changed, ascending, and labels it by count', () => {
        expect(column_widths_view_step(SHEET, [
            { column: 4, before: null, after: 180 },
            { column: 1, before: 120, after: 90 },
        ])).toEqual({
            label: 'Resize 2 columns',
            delta: {
                worksheet: SHEET,
                slice: 'columnWidths',
                columns: [
                    { column: 1, before: 120, after: 90 },
                    { column: 4, before: null, after: 180 },
                ],
            },
        });
        expect(column_widths_view_step(SHEET, [{ column: 0, before: 100, after: null }])?.label)
            .toBe('Resize column');
    });

    it('records nothing for a write that changed nothing', () => {
        expect(column_widths_view_step(SHEET, [])).toBeUndefined();
        // The host reports only changed columns; one that somehow did not is dropped.
        expect(column_widths_view_step(SHEET, [{ column: 0, before: 100, after: 100 }])).toBeUndefined();
        expect(column_widths_view_step(SHEET, [{ column: 0, before: null, after: null }])).toBeUndefined();
    });

    it('is named by the toggle when the gesture was the Auto-fit toggle', () => {
        const columns = [{ column: 0, before: null, after: 64 }, { column: 1, before: 200, after: 88 }];
        expect(column_widths_view_step(SHEET, columns, 'on')).toMatchObject({
            label: 'Auto-fit columns',
            delta: { autoFit: 'on' },
        });
        expect(column_widths_view_step(SHEET, columns, 'off')?.label).toBe('Restore column widths');
        // Several worksheets in one gesture share one label, counted across them.
        expect(column_widths_label(5)).toBe('Resize 5 columns');
        expect(column_widths_label(5, 'off')).toBe('Restore column widths');
    });

    it('replays each of its columns to the other side, null removing the stored width', () => {
        const delta = width_delta([
            { column: 1, before: 120, after: 90 },
            { column: 4, before: null, after: 180 },
        ]);
        expect(column_widths_replay_target(delta, 'undo', 6)).toEqual({
            widths: [{ column: 1, width: 120 }, { column: 4, width: null }],
            skipped: [],
        });
        expect(column_widths_replay_target(delta, 'redo', 6)).toEqual({
            widths: [{ column: 1, width: 90 }, { column: 4, width: 180 }],
            skipped: [],
        });
    });

    it('leaves out a column the worksheet no longer has, and says so', () => {
        const delta = width_delta([
            { column: 1, before: 120, after: 90 },
            { column: 4, before: null, after: 180 },
        ]);
        expect(column_widths_replay_target(delta, 'undo', 4)).toEqual({
            widths: [{ column: 1, width: 120 }],
            skipped: ['columns-gone'],
        });
        expect(column_widths_replay_target(delta, 'redo', 1)).toEqual({
            widths: [],
            skipped: ['columns-gone'],
        });
    });

    it('leaves Auto-fit as the gesture left it, in both directions', () => {
        const columns = [{ column: 0, before: 100, after: 64 }];
        const fit = width_delta(columns, 'on');
        const restore = width_delta(columns, 'off');
        const drag = width_delta(columns);
        expect(auto_fit_after_width_replay(fit, 'undo')).toBe('off');
        expect(auto_fit_after_width_replay(fit, 'redo')).toBe('on');
        expect(auto_fit_after_width_replay(restore, 'undo')).toBe('on');
        expect(auto_fit_after_width_replay(restore, 'redo')).toBe('off');
        // Any other width write ends Auto-fit, as the drag itself did.
        expect(auto_fit_after_width_replay(drag, 'undo')).toBe('off');
        expect(auto_fit_after_width_replay(drag, 'redo')).toBe('off');
    });
});

describe('a row-height write as a view step', () => {
    function height_delta(
        height: number | null,
        before: RowHeightsViewDelta['before'],
    ): RowHeightsViewDelta {
        const step = row_heights_view_step(SHEET, { height, before });
        if (step?.delta.slice !== 'rowHeights') throw new Error('expected a row-height step');
        return step.delta;
    }

    it('records the height set and what each changed row held, labelled by the rows', () => {
        expect(row_heights_view_step(SHEET, {
            height: 60,
            before: [{ start: 2, end: 2, height: null }],
        })).toEqual({
            label: 'Resize row',
            delta: {
                worksheet: SHEET,
                slice: 'rowHeights',
                after: 60,
                before: [{ start: 2, end: 2, height: null }],
            },
        });
        expect(row_heights_view_step(SHEET, {
            height: 60,
            before: [{ start: 0, end: 3, height: null }, { start: 9, end: 9, height: 40 }],
        })?.label).toBe('Resize 5 rows');
    });

    it('labels a reset, and records nothing for a write that changed nothing', () => {
        expect(row_heights_view_step(SHEET, {
            height: null,
            before: [{ start: 4, end: 4, height: 60 }],
        })?.label).toBe('Reset row height');
        expect(row_heights_view_step(SHEET, {
            height: null,
            before: [{ start: 4, end: 5, height: 60 }, { start: 7, end: 7, height: 30 }],
        })?.label).toBe('Reset 3 row heights');
        expect(row_heights_view_step(SHEET, { height: 60, before: [] })).toBeUndefined();
    });

    it('undoes each run to what it held and redoes every row to the height set', () => {
        const delta = height_delta(60, [
            { start: 0, end: 3, height: null },
            { start: 9, end: 9, height: 40 },
        ]);
        expect(row_heights_replay_target(delta, 'undo', 100)).toEqual({
            rows: [{ start: 0, end: 3, height: null }, { start: 9, end: 9, height: 40 }],
            skipped: [],
        });
        expect(row_heights_replay_target(delta, 'redo', 100)).toEqual({
            rows: [{ start: 0, end: 3, height: 60 }, { start: 9, end: 9, height: 60 }],
            skipped: [],
        });
    });

    it('undoes a reset by putting the heights back and redoes it by removing them', () => {
        const delta = height_delta(null, [{ start: 4, end: 5, height: 60 }]);
        expect(row_heights_replay_target(delta, 'undo', 100).rows)
            .toEqual([{ start: 4, end: 5, height: 60 }]);
        expect(row_heights_replay_target(delta, 'redo', 100).rows)
            .toEqual([{ start: 4, end: 5, height: null }]);
    });

    it('leaves out rows the worksheet no longer has, clipping a run that straddles the end', () => {
        const delta = height_delta(60, [
            { start: 0, end: 3, height: null },
            { start: 8, end: 12, height: 40 },
            { start: 20, end: 20, height: null },
        ]);
        expect(row_heights_replay_target(delta, 'undo', 10)).toEqual({
            rows: [{ start: 0, end: 3, height: null }, { start: 8, end: 9, height: 40 }],
            skipped: ['rows-gone'],
        });
        expect(row_heights_replay_target(delta, 'redo', 0)).toEqual({
            rows: [],
            skipped: ['rows-gone'],
        });
    });
});

describe('a row auto-fit as a view step', () => {
    const requested = [
        { start: 0, end: 2, height: 60 },
        { start: 3, end: 4, height: null },
        { start: 7, end: 7, height: 42 },
    ];

    it('records each changed row\'s own height, and only the rows the write changed', () => {
        // Rows 1 and 7 already held what the fit asked: the host left them out.
        const step = row_fit_view_step(SHEET, requested, [
            { start: 0, end: 0, height: null },
            { start: 2, end: 3, height: 30 },
            { start: 4, end: 4, height: 50 },
        ]);
        expect(step).toEqual({
            label: 'Auto-fit 4 row heights',
            delta: {
                worksheet: SHEET,
                slice: 'rowHeights',
                after: [
                    { start: 0, end: 0, height: 60 },
                    { start: 2, end: 2, height: 60 },
                    { start: 3, end: 4, height: null },
                ],
                before: [
                    { start: 0, end: 0, height: null },
                    { start: 2, end: 3, height: 30 },
                    { start: 4, end: 4, height: 50 },
                ],
            },
        });
        expect(row_fit_view_step(SHEET, requested, [{ start: 7, end: 7, height: null }])?.label)
            .toBe('Auto-fit row height');
        expect(row_fit_view_step(SHEET, requested, [])).toBeUndefined();
    });

    it('undoes each row to what it held and redoes each to its own fitted height', () => {
        const step = row_fit_view_step(SHEET, requested, [
            { start: 1, end: 3, height: 30 },
            { start: 7, end: 7, height: null },
        ]);
        if (step?.delta.slice !== 'rowHeights') throw new Error('expected a row-height step');
        expect(row_heights_replay_target(step.delta, 'undo', 100)).toEqual({
            rows: [{ start: 1, end: 3, height: 30 }, { start: 7, end: 7, height: null }],
            skipped: [],
        });
        expect(row_heights_replay_target(step.delta, 'redo', 100)).toEqual({
            rows: [
                { start: 1, end: 2, height: 60 },
                { start: 3, end: 3, height: null },
                { start: 7, end: 7, height: 42 },
            ],
            skipped: [],
        });
        // Redo clips to the rows the worksheet still has.
        expect(row_heights_replay_target(step.delta, 'redo', 3)).toEqual({
            rows: [{ start: 1, end: 2, height: 60 }],
            skipped: ['rows-gone'],
        });
    });
});

describe('the Header Row as a view step', () => {
    const change = (partial: Partial<ExcelHeaderChange>): ExcelHeaderChange => ({
        before: { mode: 'off' },
        after: { mode: 'off' },
        hidden: [],
        shown: [],
        ...partial,
    });
    const delta = (partial: Partial<ExcelHeaderChange>): HeaderViewDelta =>
        header_view_delta(SHEET, change(partial))!;
    const sheet = (hiddenRows: readonly number[] = [], sourceRowCount = 10) =>
        ({ sourceRowCount, hiddenRows });

    it('reads a side from each shape of the header metadata', () => {
        expect(excel_header_side({ mode: 'auto', active: true })).toEqual({ mode: 'auto', row: 0 });
        expect(excel_header_side({ mode: 'auto', active: false })).toEqual({ mode: 'auto' });
        expect(excel_header_side({ mode: 'on', active: true, sourceRow: 3 })).toEqual({ mode: 'on', row: 3 });
        expect(excel_header_side({ mode: 'on', active: true })).toEqual({ mode: 'on', row: 0 });
        expect(excel_header_side({ mode: 'on', active: false })).toEqual({ mode: 'on' });
        expect(excel_header_side({ mode: 'off', active: false })).toEqual({ mode: 'off' });
    });

    it('is no step when the write changed nothing', () => {
        expect(header_view_delta(SHEET, change({}))).toBeUndefined();
        expect(header_view_delta(SHEET, change({
            before: { mode: 'on', row: 2 }, after: { mode: 'on', row: 2 },
        }))).toBeUndefined();
    });

    it('holds both sides whole and the hidden rows as members', () => {
        expect(delta({
            before: { mode: 'auto', row: 0 },
            after: { mode: 'on', row: 3 },
            hidden: [2, 0, 1],
        })).toEqual({
            worksheet: SHEET,
            slice: 'header',
            before: { mode: 'auto', row: 0 },
            after: { mode: 'on', row: 3 },
            hiddenRows: { hidden: [0, 1, 2], shown: [] },
        });
        expect(delta({ before: { mode: 'on', row: 0 }, after: { mode: 'off' } }).hiddenRows)
            .toBeUndefined();
    });

    it('labels each gesture', () => {
        const use = delta({ after: { mode: 'on', row: 2 }, hidden: [0, 1] });
        const off = delta({ before: { mode: 'on', row: 0 } });
        const unhide = delta({ before: { mode: 'on', row: 2 }, shown: [0, 1] });
        expect(header_step_label([use])).toBe('Use row 3 as header');
        expect(header_step_label([delta({ after: { mode: 'on', row: 0 } })])).toBe('Use row 1 as header');
        expect(header_step_label([off])).toBe('Turn off header row');
        expect(header_step_label([unhide])).toBe('Unhide rows');
        expect(header_step_label([use, use])).toBe('Use first row as header on all sheets');
        expect(header_step_label([off, off])).toBe('Show first row as data on all sheets');
        expect(header_step_label([use, off])).toBe('Change header row');
    });

    it('undoing "use row as header" asks for the side before and shows the rows it hid', () => {
        const step = delta({ before: { mode: 'off' }, after: { mode: 'on', row: 2 }, hidden: [0, 1] });
        expect(header_replay_target(step, 'undo', sheet([0, 1]))).toEqual({
            target: { mode: 'off', hideRows: [], showRows: [0, 1] },
            skipped: [],
        });
        expect(header_replay_target(step, 'redo', sheet())).toEqual({
            target: { mode: 'on', headerSourceRow: 2, hideRows: [0, 1], showRows: [] },
            skipped: [],
        });
    });

    it('never compares: the target is the same whatever the window shows', () => {
        const step = delta({ before: { mode: 'off' }, after: { mode: 'on', row: 2 }, hidden: [0, 1] });
        const already = header_replay_target(step, 'undo', sheet());
        expect(already).toEqual(header_replay_target(step, 'undo', sheet([0, 1])));
        expect(already.target).toBeDefined();
    });

    it('an automatic side restores the detector and names no row', () => {
        const step = delta({ before: { mode: 'auto', row: 0 }, after: { mode: 'off' } });
        const { target } = header_replay_target(step, 'undo', sheet());
        expect(target).toEqual({ mode: 'auto', hideRows: [], showRows: [] });
        expect(target && 'headerSourceRow' in target).toBe(false);
        // Its row is the detector's, so a worksheet with no rows left does not skip it.
        expect(header_replay_target(step, 'undo', sheet([], 0)))
            .toEqual({ target: { mode: 'auto', hideRows: [], showRows: [] }, skipped: [] });
    });

    it('undoing Unhide all puts the header and every hidden row back in one target', () => {
        const step = delta({ before: { mode: 'on', row: 3 }, after: { mode: 'off' }, shown: [0, 1, 2, 7] });
        expect(header_replay_target(step, 'undo', sheet()).target).toEqual({
            mode: 'on', headerSourceRow: 3, hideRows: [0, 1, 2, 7], showRows: [],
        });
        expect(header_replay_target(step, 'redo', sheet([0, 1, 2, 7])).target).toEqual({
            mode: 'off', hideRows: [], showRows: [0, 1, 2, 7],
        });
    });

    it('an explicit side with no row is asked for as null, with its rows', () => {
        const step = delta({ before: { mode: 'on' }, after: { mode: 'off' }, shown: [0, 1, 2] });
        expect(header_replay_target(step, 'undo', sheet([], 3))).toEqual({
            target: { mode: 'on', headerSourceRow: null, hideRows: [0, 1, 2], showRows: [] },
            skipped: [],
        });
        // The worksheet has a row the step never knew: "on, with no row" cannot be had.
        expect(header_replay_target(step, 'undo', sheet([], 4)))
            .toEqual({ skipped: ['header-unavailable'] });
        // With no rows to change (the header was turned off over hidden rows).
        const toggled = delta({ before: { mode: 'on' }, after: { mode: 'off' } });
        expect(header_replay_target(toggled, 'undo', sheet([0, 1, 2], 3)).target)
            .toEqual({ mode: 'on', headerSourceRow: null, hideRows: [], showRows: [] });
    });

    it('skips the worksheet when the row it used as the header is gone', () => {
        const step = delta({ before: { mode: 'on', row: 8 }, after: { mode: 'off' } });
        expect(header_replay_target(step, 'undo', sheet([], 5)))
            .toEqual({ skipped: ['header-row-gone'] });
        expect(header_replay_target(step, 'redo', sheet([], 5)).target)
            .toEqual({ mode: 'off', hideRows: [], showRows: [] });
    });

    it('leaves out rows to hide that the worksheet no longer has', () => {
        const step = delta({ before: { mode: 'on', row: 1 }, after: { mode: 'off' }, shown: [0, 6, 9] });
        expect(header_replay_target(step, 'undo', sheet([], 7))).toEqual({
            target: { mode: 'on', headerSourceRow: 1, hideRows: [0, 6], showRows: [] },
            skipped: ['rows-gone'],
        });
    });

    it('skips the worksheet when more rows would be hidden than can be stored', () => {
        const count = MAX_PERSISTED_HIDDEN_ROWS + 10;
        const step = delta({
            before: { mode: 'on', row: MAX_PERSISTED_HIDDEN_ROWS + 1 },
            after: { mode: 'off' },
        });
        expect(header_replay_target(step, 'undo', sheet([], count)))
            .toEqual({ skipped: ['too-many-hidden'] });
    });
});
