import { describe, expect, it } from 'vitest';
import type { RowIdentity } from '../pending-changes';
import {
    appended_row_source_row,
    assert_valid_column_layout,
    assert_valid_row_layout,
    canonical_column_layout,
    canonical_row_layout,
    column_identities_equal,
    column_identity_key,
    column_layouts_equal,
    column_save_map,
    delete_columns,
    delete_rows,
    drop_unreferenced_column_tombstones,
    drop_unreferenced_row_tombstones,
    fixed_row_identity_key,
    has_live_column_layout_change,
    has_live_row_layout_change,
    index_column_layout,
    index_row_layout,
    insert_anchor_for_selection,
    insert_columns,
    insert_rows,
    is_source_column_layout,
    is_source_row_layout,
    MAX_COLUMN_LAYOUT_ENTRIES,
    MAX_REMOVED_ROW_INTERVALS,
    MAX_ROW_LAYOUT_RUNS,
    move_columns,
    move_rows,
    moved_source_columns,
    moved_source_rows,
    restore_columns,
    restore_rows,
    row_identities_equal,
    row_identity_key,
    row_layouts_equal,
    row_save_map,
    source_column_layout,
    source_row_layout,
    step_move_target,
    TOO_MANY_LIVE_COLUMNS_MESSAGE,
    TOO_MANY_RESTORED_ROW_GROUPS_MESSAGE,
    TOO_MANY_ROW_REMOVALS_MESSAGE,
    TOO_MANY_ROW_RUNS_MESSAGE,
    TOO_WIDE_TO_RESTRUCTURE_MESSAGE,
    validate_column_layout,
    validate_row_layout,
    type ColumnIdentity,
    type ColumnLayout,
    type ColumnLayoutContext,
    type LayoutResult,
    type RowLayout,
    type RowLayoutContext,
    type RowLayoutRun,
} from '../worksheet-layout';

// ---------------------------------------------------------------------------
// Notation: a full order is written as tokens. A number is a source row or
// column, a letter id is a pending entry, and a trailing `x` marks a tombstone
// (a removal for a source entry, a discarded entry for a pending one).
// ---------------------------------------------------------------------------

const src = (sourceRow: number): RowIdentity => ({ kind: 'source', sourceRow });
const pen = (pendingRowId: string): RowIdentity => ({ kind: 'pending', pendingRowId });
const scol = (sourceColumn: number): ColumnIdentity => ({ kind: 'source', sourceColumn });
const pcol = (pendingColumnId: string): ColumnIdentity => ({ kind: 'pending', pendingColumnId });

function row_token(identity: RowIdentity): string {
    return identity.kind === 'source' ? String(identity.sourceRow) : identity.pendingRowId;
}

function column_token(identity: ColumnIdentity): string {
    return identity.kind === 'source' ? String(identity.sourceColumn) : identity.pendingColumnId;
}

/** Expand a row layout without the index, straight from its fields. */
function expand_rows(layout: RowLayout): string[] {
    const removed = new Set<number>();
    for (const entry of layout.removedSourceRows) {
        for (let row = entry.start; row < entry.start + entry.count; row++) removed.add(row);
    }
    const discarded = new Set(layout.discardedPendingRows.map((row) => row.id));
    const out: string[] = [];
    for (const run of layout.runs) {
        if (run.kind === 'source') {
            for (let row = run.start; row < run.start + run.count; row++) {
                out.push(removed.has(row) ? `${row}x` : String(row));
            }
        } else {
            for (const id of run.ids) out.push(discarded.has(id) ? `${id}x` : id);
        }
    }
    return out;
}

function expand_columns(layout: ColumnLayout): string[] {
    const removed = new Set(layout.removedSourceColumns);
    const discarded = new Set(layout.discardedPendingColumns.map((column) => column.id));
    return layout.columns.map((column) => column.kind === 'source'
        ? (removed.has(column.sourceColumn) ? `${column.sourceColumn}x` : String(column.sourceColumn))
        : (discarded.has(column.pendingColumnId) ? `${column.pendingColumnId}x` : column.pendingColumnId));
}

/** Build a canonical row layout from tokens. Discarded ids get created orders 1000+. */
function rows_from(tokens: readonly string[]): RowLayout {
    const runs: RowLayoutRun[] = [];
    const removed: { start: number; count: number }[] = [];
    const discarded: { id: string; createdOrder: number }[] = [];
    for (const token of tokens) {
        const tomb = token.endsWith('x');
        const name = tomb ? token.slice(0, -1) : token;
        if (/^\d+$/.test(name)) {
            const row = Number(name);
            runs.push({ kind: 'source', start: row, count: 1 });
            if (tomb) removed.push({ start: row, count: 1 });
        } else {
            runs.push({ kind: 'pending', ids: [name] });
            if (tomb) discarded.push({ id: name, createdOrder: 1000 + discarded.length });
        }
    }
    return canonical_row_layout({ runs, removedSourceRows: removed, discardedPendingRows: discarded });
}

function columns_from(tokens: readonly string[]): ColumnLayout {
    const columns: ColumnIdentity[] = [];
    const removed: number[] = [];
    const discarded: { id: string; createdOrder: number }[] = [];
    for (const token of tokens) {
        const tomb = token.endsWith('x');
        const name = tomb ? token.slice(0, -1) : token;
        if (/^\d+$/.test(name)) {
            columns.push(scol(Number(name)));
            if (tomb) removed.push(Number(name));
        } else {
            columns.push(pcol(name));
            if (tomb) discarded.push({ id: name, createdOrder: 1000 + discarded.length });
        }
    }
    return canonical_column_layout({ columns, removedSourceColumns: removed, discardedPendingColumns: discarded });
}

/** A validator context matching a layout: every live pending id is an inserted row. */
function row_context(layout: RowLayout, body_start: number, body_row_count: number): RowLayoutContext {
    const discarded = new Set(layout.discardedPendingRows.map((row) => row.id));
    const live = layout.runs.flatMap((run) => run.kind === 'pending' ? run.ids : [])
        .filter((id) => !discarded.has(id));
    return {
        bodyStart: body_start,
        bodyRowCount: body_row_count,
        pendingRows: live.map((id, order) => ({ id, origin: 'insert' as const, createdOrder: order })),
        mintedAsInsert: () => true,
    };
}

function column_context(layout: ColumnLayout, source_column_count: number): ColumnLayoutContext {
    const discarded = new Set(layout.discardedPendingColumns.map((column) => column.id));
    return {
        sourceColumnCount: source_column_count,
        pendingColumns: layout.columns
            .filter((column): column is { kind: 'pending'; pendingColumnId: string } =>
                column.kind === 'pending' && !discarded.has(column.pendingColumnId))
            .map((column, order) => ({ id: column.pendingColumnId, createdOrder: order })),
    };
}

function ok<L>(result: LayoutResult<L>): L {
    if (!result.ok) throw new Error(`refused: ${result.refusal.reason}: ${result.refusal.message}`);
    return result.layout;
}

function refusal<L>(result: LayoutResult<L>): string {
    if (result.ok) throw new Error('expected a refusal');
    return result.refusal.reason;
}

const no_order = (): number => {
    throw new Error('no pending rows expected');
};

// ---------------------------------------------------------------------------
// Constructors and predicates
// ---------------------------------------------------------------------------

describe('source layouts and predicates', () => {
    it('builds the source row layout of a body, or none for a header-only sheet', () => {
        expect(source_row_layout(1, 4)).toEqual({
            runs: [{ kind: 'source', start: 1, count: 4 }],
            removedSourceRows: [],
            discardedPendingRows: [],
        });
        expect(source_row_layout(1, 0).runs).toEqual([]);
        expect(is_source_row_layout(source_row_layout(1, 4))).toBe(true);
        expect(is_source_row_layout(source_row_layout(1, 0))).toBe(true);
        expect(validate_row_layout(source_row_layout(3, 5), row_context(source_row_layout(3, 5), 3, 5)))
            .toBeUndefined();
    });

    it('builds the source column layout', () => {
        expect(expand_columns(source_column_layout(3))).toEqual(['0', '1', '2']);
        expect(is_source_column_layout(source_column_layout(3))).toBe(true);
        expect(is_source_column_layout(columns_from(['1', '0']))).toBe(false);
    });

    it('distinguishes a live layout change from a tombstone-only layout', () => {
        const tombstone_only = rows_from(['0', 'ax', '1', '2']);
        expect(is_source_row_layout(tombstone_only)).toBe(false);
        expect(has_live_row_layout_change(tombstone_only)).toBe(false);
        expect(has_live_row_layout_change(rows_from(['0', 'a', '1']))).toBe(true);
        expect(has_live_row_layout_change(rows_from(['0', '1x', '2']))).toBe(true);
        expect(has_live_row_layout_change(rows_from(['1', '0', '2']))).toBe(true);
        expect(has_live_row_layout_change(source_row_layout(0, 3))).toBe(false);

        expect(has_live_column_layout_change(columns_from(['0', 'ax', '1']))).toBe(false);
        expect(has_live_column_layout_change(columns_from(['0', 'a', '1']))).toBe(true);
        expect(has_live_column_layout_change(columns_from(['0x', '1']))).toBe(true);
        expect(has_live_column_layout_change(columns_from(['1', '0']))).toBe(true);
    });

    it('canonicalizes runs, removals, and discarded rows', () => {
        const messy: RowLayout = {
            runs: [
                { kind: 'source', start: 0, count: 2 },
                { kind: 'source', start: 2, count: 1 },
                { kind: 'pending', ids: [] },
                { kind: 'pending', ids: ['a'] },
                { kind: 'pending', ids: ['b'] },
                { kind: 'source', start: 3, count: 0 },
                { kind: 'source', start: 3, count: 2 },
            ],
            removedSourceRows: [{ start: 4, count: 1 }, { start: 0, count: 1 }, { start: 1, count: 1 }],
            discardedPendingRows: [{ id: 'b', createdOrder: 5 }, { id: 'a', createdOrder: 2 }],
        };
        expect(canonical_row_layout(messy)).toEqual({
            runs: [
                { kind: 'source', start: 0, count: 3 },
                { kind: 'pending', ids: ['a', 'b'] },
                { kind: 'source', start: 3, count: 2 },
            ],
            removedSourceRows: [{ start: 0, count: 2 }, { start: 4, count: 1 }],
            discardedPendingRows: [{ id: 'a', createdOrder: 2 }, { id: 'b', createdOrder: 5 }],
        });
        expect(row_layouts_equal(messy, canonical_row_layout(messy))).toBe(true);
        expect(row_layouts_equal(messy, source_row_layout(0, 5))).toBe(false);
        expect(column_layouts_equal(
            { columns: [scol(0), scol(1)], removedSourceColumns: [1, 0], discardedPendingColumns: [] },
            { columns: [scol(0), scol(1)], removedSourceColumns: [0, 1], discardedPendingColumns: [] },
        )).toBe(true);
    });

    it('returns frozen layouts', () => {
        const layout = ok(insert_rows(source_row_layout(0, 3), src(1), 'before', ['a']));
        expect(Object.isFrozen(layout)).toBe(true);
        expect(Object.isFrozen(layout.runs)).toBe(true);
        expect(Object.isFrozen(layout.runs[0])).toBe(true);
    });

    it('keys identities and places the append band after the live layout', () => {
        expect(row_identity_key(src(4))).toBe('s:4');
        expect(row_identity_key(pen('a'))).toBe('p:a');
        expect(fixed_row_identity_key(0)).toBe('f:0');
        expect(column_identity_key(scol(2))).toBe('s:2');
        expect(column_identity_key(pcol('c'))).toBe('p:c');
        expect(row_identities_equal(src(1), src(1))).toBe(true);
        expect(row_identities_equal(src(1), pen('1'))).toBe(false);
        expect(column_identities_equal(pcol('a'), pcol('a'))).toBe(true);
        expect(column_identities_equal(scol(0), scol(1))).toBe(false);
        // Header Row 2 (bodyStart 2), N = 5: the first appended row is 1-based row 8, 0-based 7.
        expect(appended_row_source_row(2, 5, 0)).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe('validate_row_layout', () => {
    const valid = rows_from(['1', 'a', '2x', 'bx', '3']);
    const context = (): RowLayoutContext => ({
        bodyStart: 1,
        bodyRowCount: 3,
        pendingRows: [
            { id: 'a', origin: 'insert', createdOrder: 1 },
            { id: 'z', createdOrder: 2 },
        ],
        mintedAsInsert: (id) => id !== 'z',
    });
    const reason = (layout: RowLayout, override: Partial<RowLayoutContext> = {}): string | undefined =>
        validate_row_layout(layout, { ...context(), ...override })?.reason;

    it('accepts a valid layout with inserted, appended, removed, and discarded rows', () => {
        expect(reason(valid)).toBeUndefined();
        expect(() => assert_valid_row_layout(valid, context())).not.toThrow();
    });

    it('requires every source body row in exactly one run (invariant 1)', () => {
        expect(reason({ ...valid, runs: valid.runs.slice(0, -1) })).toBe('source-coverage');
        expect(reason({ ...valid, runs: [...valid.runs, { kind: 'source', start: 2, count: 1 }] }))
            .toBe('source-coverage');
        expect(reason({ ...valid, runs: [{ kind: 'source', start: 0, count: 1 }, ...valid.runs] }))
            .toBe('source-coverage');
        expect(reason({ ...valid, runs: [...valid.runs, { kind: 'source', start: 4, count: 1 }] }))
            .toBe('source-coverage');
        expect(() => assert_valid_row_layout({ ...valid, runs: valid.runs.slice(0, -1) }, context()))
            .toThrow(/missing/);
    });

    it('requires each inserted row in one pending run and no appended row in any (invariant 2)', () => {
        expect(reason(rows_from(['1', '2x', 'bx', '3']))).toBe('pending-membership');
        expect(reason(rows_from(['1', 'a', 'z', '2x', 'bx', '3']))).toBe('pending-membership');
        expect(reason(rows_from(['1', 'a', 'q', '2x', 'bx', '3']))).toBe('pending-membership');
        expect(reason({
            ...valid,
            runs: [...valid.runs.slice(0, 1), { kind: 'pending', ids: ['a', 'a'] }, ...valid.runs.slice(2)],
        })).toBe('pending-membership');
        expect(reason(valid, {
            pendingRows: [...context().pendingRows, { id: 'a', origin: 'insert', createdOrder: 9 }],
        })).toBe('pending-membership');
    });

    it('checks discarded tombstones and creation orders (invariant 3)', () => {
        expect(reason({ ...valid, discardedPendingRows: [{ id: 'q', createdOrder: 7 }, ...valid.discardedPendingRows] }))
            .toBe('discarded-tombstone');
        expect(reason(valid, { mintedAsInsert: () => false })).toBe('discarded-tombstone');
        expect(reason({ ...valid, discardedPendingRows: [{ id: 'a', createdOrder: 7 }, { id: 'b', createdOrder: 8 }] }))
            .toBe('discarded-tombstone');
        expect(reason({ ...valid, discardedPendingRows: [{ id: 'b', createdOrder: 1 }] })).toBe('created-order');
        expect(reason(valid, {
            pendingRows: [{ id: 'a', origin: 'insert', createdOrder: 1 }, { id: 'z', createdOrder: 1 }],
        })).toBe('created-order');
        expect(reason({ ...valid, discardedPendingRows: [{ id: 'b', createdOrder: -1 }] })).toBe('created-order');
        expect(reason({ ...valid, discardedPendingRows: [] })).toBe('pending-membership');
        // A discarded id that is still live in appendedRows.
        expect(reason(valid, {
            pendingRows: [...context().pendingRows, { id: 'b', origin: 'insert', createdOrder: 3 }],
        })).toBe('discarded-tombstone');
    });

    it('requires canonical runs (invariant 4)', () => {
        expect(reason({ ...valid, runs: [{ kind: 'source', start: 1, count: 0 }, ...valid.runs] })).toBe('non-canonical');
        expect(reason({ ...valid, runs: [...valid.runs, { kind: 'pending', ids: [] }] })).toBe('non-canonical');
        const split: RowLayout = {
            runs: [{ kind: 'source', start: 1, count: 1 }, { kind: 'source', start: 2, count: 2 }],
            removedSourceRows: [],
            discardedPendingRows: [],
        };
        expect(reason(split, { pendingRows: [] })).toBe('non-canonical');
        const pending_pair: RowLayout = {
            runs: [{ kind: 'source', start: 1, count: 3 }, { kind: 'pending', ids: ['a'] }, { kind: 'pending', ids: ['b'] }],
            removedSourceRows: [],
            discardedPendingRows: [],
        };
        expect(reason(pending_pair, {
            pendingRows: [{ id: 'a', origin: 'insert', createdOrder: 1 }, { id: 'b', origin: 'insert', createdOrder: 2 }],
        })).toBe('non-canonical');
        // Descending neighbors are canonical: they don't continue each other.
        expect(reason(rows_from(['3', '2', '1']), { pendingRows: [] })).toBeUndefined();
    });

    it('requires sorted, disjoint, non-adjacent removal intervals within the body (invariant 5)', () => {
        const base = source_row_layout(1, 5);
        const with_removed = (removedSourceRows: { start: number; count: number }[]): string | undefined =>
            reason({ ...base, removedSourceRows }, { bodyRowCount: 5, pendingRows: [] });
        expect(with_removed([{ start: 1, count: 1 }, { start: 3, count: 2 }])).toBeUndefined();
        expect(with_removed([{ start: 3, count: 1 }, { start: 1, count: 1 }])).toBe('removed-entries');
        expect(with_removed([{ start: 1, count: 2 }, { start: 2, count: 1 }])).toBe('removed-entries');
        expect(with_removed([{ start: 1, count: 1 }, { start: 2, count: 1 }])).toBe('removed-entries');
        expect(with_removed([{ start: 1, count: 0 }])).toBe('removed-entries');
        expect(with_removed([{ start: 0, count: 1 }])).toBe('removed-entries');
        expect(with_removed([{ start: 5, count: 2 }])).toBe('removed-entries');
        expect(with_removed([{ start: 1.5, count: 1 }])).toBe('malformed');
    });

    it('enforces the run and removal limits with the spec messages (invariant 7)', () => {
        const many_runs = rows_from(Array.from({ length: MAX_ROW_LAYOUT_RUNS + 1 }, (_, i) => String(MAX_ROW_LAYOUT_RUNS - i)));
        expect(validate_row_layout(many_runs, row_context(many_runs, 0, MAX_ROW_LAYOUT_RUNS + 1)))
            .toEqual({ reason: 'too-many-runs', message: TOO_MANY_ROW_RUNS_MESSAGE });
        const body = 2 * (MAX_REMOVED_ROW_INTERVALS + 1);
        const many_removals: RowLayout = {
            ...source_row_layout(0, body),
            removedSourceRows: Array.from({ length: MAX_REMOVED_ROW_INTERVALS + 1 }, (_, i) => ({ start: 2 * i, count: 1 })),
        };
        expect(validate_row_layout(many_removals, row_context(many_removals, 0, body)))
            .toEqual({ reason: 'too-many-removals', message: TOO_MANY_ROW_REMOVALS_MESSAGE });
    });

    it('rejects malformed shapes without throwing', () => {
        const bad = (layout: unknown): string | undefined =>
            validate_row_layout(layout as RowLayout, { ...context(), pendingRows: [] })?.reason;
        expect(bad(null)).toBe('malformed');
        expect(bad({ runs: [] })).toBe('malformed');
        expect(bad({ runs: [{ kind: 'other' }], removedSourceRows: [], discardedPendingRows: [] })).toBe('malformed');
        expect(bad({ runs: [{ kind: 'source', start: '1', count: 3 }], removedSourceRows: [], discardedPendingRows: [] }))
            .toBe('malformed');
        expect(bad({ runs: [{ kind: 'pending', ids: [''] }], removedSourceRows: [], discardedPendingRows: [] }))
            .toBe('malformed');
        expect(bad({ ...valid, discardedPendingRows: [{ createdOrder: 1 }] })).toBe('malformed');
    });
});

describe('validate_column_layout', () => {
    const valid = columns_from(['1', 'a', '0x', 'bx', '2']);
    const context = (): ColumnLayoutContext => ({
        sourceColumnCount: 3,
        pendingColumns: [{ id: 'a', createdOrder: 1 }],
    });
    const reason = (layout: ColumnLayout, override: Partial<ColumnLayoutContext> = {}): string | undefined =>
        validate_column_layout(layout, { ...context(), ...override })?.reason;

    it('accepts a valid layout', () => {
        expect(reason(valid)).toBeUndefined();
        expect(() => assert_valid_column_layout(valid, context())).not.toThrow();
    });

    it('requires every source column, Pending Column, and discarded id exactly once (invariant 6)', () => {
        expect(reason({ ...valid, columns: valid.columns.slice(0, -1) })).toBe('source-coverage');
        expect(reason({ ...valid, columns: [...valid.columns, scol(1)] })).toBe('source-coverage');
        expect(reason({ ...valid, columns: [...valid.columns, scol(3)] })).toBe('source-coverage');
        expect(reason({ ...valid, columns: [...valid.columns, pcol('a')] })).toBe('pending-membership');
        expect(reason({ ...valid, columns: [...valid.columns, pcol('q')] })).toBe('pending-membership');
        expect(reason(valid, { pendingColumns: [] })).toBe('pending-membership');
        expect(reason(valid, { pendingColumns: [...context().pendingColumns, { id: 'q', createdOrder: 2 }] }))
            .toBe('pending-membership');
        expect(reason(valid, { pendingColumns: [...context().pendingColumns, { id: 'b', createdOrder: 2 }] }))
            .toBe('discarded-tombstone');
        expect(reason({ ...valid, discardedPendingColumns: [{ id: 'q', createdOrder: 5 }, { id: 'b', createdOrder: 6 }] }))
            .toBe('discarded-tombstone');
        expect(reason({ ...valid, discardedPendingColumns: [{ id: 'b', createdOrder: 1 }] })).toBe('created-order');
    });

    it('requires ascending, unique, in-range removals', () => {
        expect(reason({ ...valid, removedSourceColumns: [2, 0] })).toBe('removed-entries');
        expect(reason({ ...valid, removedSourceColumns: [0, 0] })).toBe('removed-entries');
        expect(reason({ ...valid, removedSourceColumns: [3] })).toBe('removed-entries');
    });

    it('enforces the column limits (invariant 7)', () => {
        const live_257 = columns_from([
            ...Array.from({ length: 200 }, (_, i) => String(i)),
            ...Array.from({ length: 57 }, (_, i) => `p${i}`),
        ]);
        expect(validate_column_layout(live_257, column_context(live_257, 200)))
            .toEqual({ reason: 'too-many-live-columns', message: TOO_MANY_LIVE_COLUMNS_MESSAGE });
        // 256 source columns, 10 of them removed, 10 live and 247 discarded Pending Columns.
        const entries_513 = columns_from([
            ...Array.from({ length: 256 }, (_, i) => (i < 10 ? `${i}x` : String(i))),
            ...Array.from({ length: 10 }, (_, i) => `q${i}`),
            ...Array.from({ length: 247 }, (_, i) => `p${i}x`),
        ]);
        expect(entries_513.columns.length).toBe(MAX_COLUMN_LAYOUT_ENTRIES + 1);
        expect(reason(entries_513, column_context(entries_513, 256))).toBe('too-many-column-entries');
        const discarded_257 = columns_from([
            ...Array.from({ length: 10 }, (_, i) => String(i)),
            ...Array.from({ length: 257 }, (_, i) => `p${i}x`),
        ]);
        expect(reason(discarded_257, column_context(discarded_257, 10))).toBe('too-many-discarded-columns');
    });

    it('refuses a changed layout of a source wider than 256 columns, but not its source layout', () => {
        const wide = source_column_layout(300);
        expect(reason(wide, { sourceColumnCount: 300, pendingColumns: [] })).toBeUndefined();
        const changed = { ...wide, removedSourceColumns: [0] };
        expect(validate_column_layout(changed, { sourceColumnCount: 300, pendingColumns: [] }))
            .toEqual({ reason: 'too-wide-to-restructure', message: TOO_WIDE_TO_RESTRUCTURE_MESSAGE });
    });
});

// ---------------------------------------------------------------------------
// Operations and gluing
// ---------------------------------------------------------------------------

describe('row operations', () => {
    it('inserts before and after a live row', () => {
        const base = source_row_layout(1, 3);
        expect(expand_rows(ok(insert_rows(base, src(2), 'before', ['a', 'b'])))).toEqual(['1', 'a', 'b', '2', '3']);
        expect(expand_rows(ok(insert_rows(base, src(2), 'after', ['a'])))).toEqual(['1', '2', 'a', '3']);
        expect(expand_rows(ok(insert_rows(base, src(3), 'after', ['a'])))).toEqual(['1', '2', '3', 'a']);
        const with_pending = ok(insert_rows(base, src(1), 'after', ['a']));
        expect(expand_rows(ok(insert_rows(with_pending, pen('a'), 'after', ['b'])))).toEqual(['1', 'a', 'b', '2', '3']);
        expect(ok(insert_rows(with_pending, pen('a'), 'after', ['b'])).runs)
            .toEqual([{ kind: 'source', start: 1, count: 1 }, { kind: 'pending', ids: ['a', 'b'] }, { kind: 'source', start: 2, count: 2 }]);
    });

    it('inserts at the very start after tombstones glued to the start', () => {
        const layout = rows_from(['1x', 'ax', '2', '3']);
        expect(expand_rows(ok(insert_rows(layout, src(2), 'before', ['b'])))).toEqual(['1x', 'ax', 'b', '2', '3']);
    });

    it('inserts after a row\'s glued tombstones, from either side', () => {
        const layout = rows_from(['1', '2x', 'ax', '3']);
        expect(expand_rows(ok(insert_rows(layout, src(1), 'after', ['b'])))).toEqual(['1', '2x', 'ax', 'b', '3']);
        expect(expand_rows(ok(insert_rows(layout, src(3), 'before', ['b'])))).toEqual(['1', '2x', 'ax', 'b', '3']);
        expect(expand_rows(ok(insert_rows(rows_from(['1', '2x']), src(1), 'after', ['b'])))).toEqual(['1', '2x', 'b']);
    });

    it('refuses inserts on tombstones, unknown rows, and bad ids', () => {
        const layout = rows_from(['1', '2x', 'a', 'bx']);
        expect(refusal(insert_rows(layout, src(2), 'after', ['c']))).toBe('no-live-entry');
        expect(refusal(insert_rows(layout, pen('b'), 'after', ['c']))).toBe('no-live-entry');
        expect(refusal(insert_rows(layout, src(9), 'after', ['c']))).toBe('unknown-identity');
        expect(refusal(insert_rows(layout, pen('q'), 'after', ['c']))).toBe('unknown-identity');
        expect(refusal(insert_rows(layout, src(1), 'after', []))).toBe('invalid-pending-id');
        expect(refusal(insert_rows(layout, src(1), 'after', ['c', 'c']))).toBe('invalid-pending-id');
        expect(refusal(insert_rows(layout, src(1), 'after', ['b']))).toBe('invalid-pending-id');
        expect(refusal(insert_rows(layout, src(1), 'after', ['']))).toBe('invalid-pending-id');
    });

    it('anchors Insert on the live rows of a selection', () => {
        const layout = rows_from(['1', '2', '3x', '4']);
        const index = index_row_layout(layout);
        const selection = [src(2), src(3)];
        expect(insert_anchor_for_selection(index, selection, 'after')).toEqual(src(2));
        expect(insert_anchor_for_selection(index, [src(3), src(4)], 'before')).toEqual(src(4));
        expect(insert_anchor_for_selection(index, [src(3)], 'after')).toBeUndefined();
        const anchor = insert_anchor_for_selection(index, selection, 'after')!;
        expect(expand_rows(ok(insert_rows(layout, anchor, 'after', ['a'])))).toEqual(['1', '2', '3x', 'a', '4']);
    });

    it('deletes source rows into removals and pending rows into discarded tombstones', () => {
        const layout = ok(insert_rows(source_row_layout(0, 4), src(1), 'after', ['a', 'b']));
        const deleted = ok(delete_rows(layout, [src(0), src(2), pen('a'), src(3)], (id) => (id === 'a' ? 7 : -1)));
        expect(expand_rows(deleted)).toEqual(['0x', '1', 'ax', 'b', '2x', '3x']);
        expect(deleted.removedSourceRows).toEqual([{ start: 0, count: 1 }, { start: 2, count: 2 }]);
        expect(deleted.discardedPendingRows).toEqual([{ id: 'a', createdOrder: 7 }]);
        // Deleting tombstones again changes nothing.
        expect(row_layouts_equal(ok(delete_rows(deleted, [src(0), pen('a')], no_order)), deleted)).toBe(true);
        expect(refusal(delete_rows(deleted, [src(9)], no_order))).toBe('unknown-identity');
        expect(refusal(delete_rows(deleted, [pen('b')], () => Number.NaN))).toBe('invalid-created-order');
    });

    it('restores in place, and delete then restore returns the source layout', () => {
        const base = source_row_layout(1, 5);
        const deleted = ok(delete_rows(base, [src(2), src(3), src(4)], no_order));
        expect(expand_rows(deleted)).toEqual(['1', '2x', '3x', '4x', '5']);
        const partly = ok(restore_rows(deleted, [3]));
        expect(expand_rows(partly)).toEqual(['1', '2x', '3', '4x', '5']);
        expect(partly.removedSourceRows).toEqual([{ start: 2, count: 1 }, { start: 4, count: 1 }]);
        expect(row_layouts_equal(ok(restore_rows(deleted, [2, 3, 4])), base)).toBe(true);
        expect(refusal(restore_rows(deleted, [1]))).toBe('not-removed');
        expect(refusal(restore_rows(deleted, [9]))).toBe('not-removed');
    });

    it('re-glues a deleted row\'s tombstones to the row it now glues to', () => {
        const layout = rows_from(['1', '2', '3x', '4']);
        const deleted = ok(delete_rows(layout, [src(2)], no_order));
        expect(expand_rows(deleted)).toEqual(['1', '2x', '3x', '4']);
        expect(expand_rows(ok(move_rows(deleted, [src(1)], 'end')))).toEqual(['4', '1', '2x', '3x']);
    });

    it('moves blocks with their glued tombstones', () => {
        const layout = rows_from(['1', '2', '3x', '4', '5']);
        expect(expand_rows(ok(move_rows(layout, [src(2)], 'end')))).toEqual(['1', '4', '5', '2', '3x']);
        expect(expand_rows(ok(move_rows(layout, [src(1)], src(5))))).toEqual(['2', '3x', '4', '1', '5']);
        expect(expand_rows(ok(move_rows(layout, [src(4), src(5)], src(1))))).toEqual(['4', '5', '1', '2', '3x']);
        // A selection that mixes live rows and tombstones moves the live rows.
        expect(expand_rows(ok(move_rows(layout, [src(2), src(3)], 'end')))).toEqual(['1', '4', '5', '2', '3x']);
    });

    it('resolves a drop between a live row and its glued tombstones to after them', () => {
        const layout = rows_from(['1', '2', '3x', 'ax', '4']);
        expect(expand_rows(ok(move_rows(layout, [src(1)], src(3))))).toEqual(['2', '3x', 'ax', '1', '4']);
        expect(expand_rows(ok(move_rows(layout, [src(1)], pen('a'))))).toEqual(['2', '3x', 'ax', '1', '4']);
        expect(expand_rows(ok(move_rows(rows_from(['1', '2', '3x']), [src(1)], src(3))))).toEqual(['2', '3x', '1']);
        // A drop among start-glued tombstones lands before the first live row.
        expect(expand_rows(ok(move_rows(rows_from(['1x', '2', '3']), [src(3)], src(1))))).toEqual(['1x', '3', '2']);
    });

    it('treats a drop onto the moving block as no move', () => {
        const layout = source_row_layout(1, 5);
        expect(row_layouts_equal(ok(move_rows(layout, [src(2), src(3)], src(3))), layout)).toBe(true);
        expect(row_layouts_equal(ok(move_rows(layout, [src(2), src(3)], src(4))), layout)).toBe(true);
        expect(row_layouts_equal(ok(move_rows(layout, [src(2)], src(2))), layout)).toBe(true);
    });

    it('refuses moves without a live row or with unknown identities', () => {
        const layout = rows_from(['1', '2x', '3']);
        expect(refusal(move_rows(layout, [src(2)], 'end'))).toBe('no-live-entry');
        expect(refusal(move_rows(layout, [], 'end'))).toBe('no-live-entry');
        expect(refusal(move_rows(layout, [src(9)], 'end'))).toBe('unknown-identity');
        expect(refusal(move_rows(layout, [src(1)], pen('zz')))).toBe('unknown-identity');
    });

    it('steps one live row, with its glued tombstones, per Move up or down', () => {
        const layout = rows_from(['1', '2', '3x', '4']);
        const index = index_row_layout(layout);
        const down = step_move_target(index, [src(1)], 'forward')!;
        expect(down).toEqual(src(4));
        expect(expand_rows(ok(move_rows(layout, [src(1)], down)))).toEqual(['2', '3x', '1', '4']);
        expect(step_move_target(index, [src(2)], 'forward')).toBe('end');
        expect(expand_rows(ok(move_rows(layout, [src(2)], 'end')))).toEqual(['1', '4', '2', '3x']);
        expect(step_move_target(index, [src(4)], 'forward')).toBeUndefined();

        const up = step_move_target(index, [src(4)], 'backward')!;
        expect(up).toEqual(src(2));
        expect(expand_rows(ok(move_rows(layout, [src(4)], up)))).toEqual(['1', '4', '2', '3x']);
        expect(step_move_target(index, [src(1)], 'backward')).toBeUndefined();
        expect(step_move_target(index, [src(3)], 'backward')).toBeUndefined();
        // A selection ending in a tombstone steps by its live rows.
        expect(step_move_target(index, [src(2), src(3)], 'backward')).toEqual(src(1));
    });

    it('moves pending rows and keeps their identity', () => {
        const layout = ok(insert_rows(source_row_layout(0, 3), src(0), 'after', ['a']));
        const moved = ok(move_rows(layout, [pen('a')], 'end'));
        expect(expand_rows(moved)).toEqual(['0', '1', '2', 'a']);
        expect(moved.runs).toEqual([{ kind: 'source', start: 0, count: 3 }, { kind: 'pending', ids: ['a'] }]);
    });

    it('merges runs back when a move restores the source order', () => {
        const layout = ok(move_rows(source_row_layout(0, 5), [src(1)], 'end'));
        expect(layout.runs.length).toBe(3);
        expect(row_layouts_equal(ok(move_rows(layout, [src(1)], src(2))), source_row_layout(0, 5))).toBe(true);
    });

    it('drops unreferenced discarded rows and merges what they separated', () => {
        const layout = ok(delete_rows(
            ok(insert_rows(source_row_layout(0, 4), src(1), 'after', ['a', 'b'])),
            [pen('a'), pen('b')],
            (id) => (id === 'a' ? 1 : 2),
        ));
        expect(expand_rows(layout)).toEqual(['0', '1', 'ax', 'bx', '2', '3']);
        const kept_b = drop_unreferenced_row_tombstones(layout, (id) => id === 'b');
        expect(expand_rows(kept_b)).toEqual(['0', '1', 'bx', '2', '3']);
        expect(kept_b.discardedPendingRows).toEqual([{ id: 'b', createdOrder: 2 }]);
        const none = drop_unreferenced_row_tombstones(layout, () => false);
        expect(row_layouts_equal(none, source_row_layout(0, 4))).toBe(true);
    });

    it('works on a million-row body through runs, without expanding it', () => {
        const body = 1_000_000;
        let layout = source_row_layout(1, body);
        layout = ok(move_rows(layout, [src(500_000), src(500_001)], src(10)));
        layout = ok(insert_rows(layout, src(999_999), 'after', ['a']));
        layout = ok(delete_rows(layout, [src(2), src(700_000)], no_order));
        expect(layout.runs.length).toBe(6);
        const index = index_row_layout(layout);
        expect(index.liveCount).toBe(body - 2 + 1);
        expect(index.body_index_of(src(500_000))).toBe(9);
        expect(index.identity_at_body_index(index.liveCount)).toEqual(src(body));
        expect(index.body_index_of(pen('a'))).toBe(index.liveCount - 1);
        expect(moved_source_rows(layout)).toEqual([{ start: 500_000, count: 2 }]);
        expect(row_save_map(layout).rowRuns).toEqual([
            { sourceRow: 1, count: 1, bodyIndex: 0 },
            { sourceRow: 3, count: 7, bodyIndex: 1 },
            { sourceRow: 10, count: 499_990, bodyIndex: 10 },
            { sourceRow: 500_000, count: 2, bodyIndex: 8 },
            { sourceRow: 500_002, count: 199_998, bodyIndex: 500_000 },
            { sourceRow: 700_001, count: 299_999, bodyIndex: 699_998 },
            { sourceRow: 1_000_000, count: 1, bodyIndex: 999_998 },
        ]);
    });

    it('refuses an insert or move past the run limit', () => {
        const at_limit = rows_from(Array.from({ length: MAX_ROW_LAYOUT_RUNS }, (_, i) => String(MAX_ROW_LAYOUT_RUNS - 1 - i)));
        expect(at_limit.runs.length).toBe(MAX_ROW_LAYOUT_RUNS);
        const result = insert_rows(at_limit, src(5), 'after', ['a']);
        expect(result).toEqual({ ok: false, refusal: { reason: 'too-many-runs', message: TOO_MANY_ROW_RUNS_MESSAGE } });
        // Moving the descending tail's last row elsewhere keeps the run count, so it is allowed.
        expect(move_rows(at_limit, [src(0)], src(5)).ok).toBe(true);
    });

    it('refuses a delete or restore past the removal limit', () => {
        const body = 2 * MAX_REMOVED_ROW_INTERVALS + 2;
        const at_limit: RowLayout = {
            ...source_row_layout(0, body),
            removedSourceRows: Array.from({ length: MAX_REMOVED_ROW_INTERVALS }, (_, i) => ({ start: 2 * i, count: 1 })),
        };
        expect(delete_rows(at_limit, [src(body - 1)], no_order))
            .toEqual({ ok: false, refusal: { reason: 'too-many-removals', message: TOO_MANY_ROW_REMOVALS_MESSAGE } });
        // Deleting a row that joins two intervals lowers the count.
        expect(ok(delete_rows(at_limit, [src(1)], no_order)).removedSourceRows.length).toBe(MAX_REMOVED_ROW_INTERVALS - 1);

        const triples: RowLayout = {
            ...source_row_layout(0, 4 * MAX_REMOVED_ROW_INTERVALS),
            removedSourceRows: Array.from({ length: MAX_REMOVED_ROW_INTERVALS }, (_, i) => ({ start: 4 * i, count: 3 })),
        };
        expect(restore_rows(triples, [1]))
            .toEqual({ ok: false, refusal: { reason: 'too-many-removals', message: TOO_MANY_RESTORED_ROW_GROUPS_MESSAGE } });
        expect(restore_rows(triples, [0]).ok).toBe(true);
    });
});

describe('column operations', () => {
    it('inserts, deletes, restores, and moves columns with the row gluing rules', () => {
        const base = source_column_layout(4);
        const inserted = ok(insert_columns(base, scol(1), 'after', ['a']));
        expect(expand_columns(inserted)).toEqual(['0', '1', 'a', '2', '3']);
        const deleted = ok(delete_columns(inserted, [scol(2), pcol('a')], () => 5));
        expect(expand_columns(deleted)).toEqual(['0', '1', 'ax', '2x', '3']);
        expect(deleted.discardedPendingColumns).toEqual([{ id: 'a', createdOrder: 5 }]);
        expect(expand_columns(ok(move_columns(deleted, [scol(1)], 'end')))).toEqual(['0', '3', '1', 'ax', '2x']);
        expect(expand_columns(ok(move_columns(deleted, [scol(0)], scol(2))))).toEqual(['1', 'ax', '2x', '0', '3']);
        expect(expand_columns(ok(insert_columns(deleted, scol(3), 'before', ['b'])))).toEqual(['0', '1', 'ax', '2x', 'b', '3']);
        expect(expand_columns(ok(restore_columns(deleted, [2])))).toEqual(['0', '1', 'ax', '2', '3']);
        expect(refusal(restore_columns(deleted, [1]))).toBe('not-removed');
        expect(refusal(insert_columns(deleted, scol(2), 'after', ['b']))).toBe('no-live-entry');
        expect(refusal(move_columns(deleted, [pcol('a')], 'end'))).toBe('no-live-entry');
        expect(refusal(delete_columns(deleted, [scol(7)], () => 0))).toBe('unknown-identity');
        const dropped = drop_unreferenced_column_tombstones(deleted, () => false);
        expect(expand_columns(dropped)).toEqual(['0', '1', '2x', '3']);
    });

    it('refuses more than 256 live columns on insert and restore', () => {
        const full = source_column_layout(256);
        expect(insert_columns(full, scol(0), 'after', ['a']))
            .toEqual({ ok: false, refusal: { reason: 'too-many-live-columns', message: TOO_MANY_LIVE_COLUMNS_MESSAGE } });
        const swapped = ok(insert_columns(ok(delete_columns(full, [scol(0)], () => 0)), scol(1), 'before', ['a']));
        expect(refusal(restore_columns(swapped, [0]))).toBe('too-many-live-columns');
    });

    it('refuses more than 512 column entries', () => {
        let layout = ok(delete_columns(source_column_layout(256), [scol(255)], () => 0));
        for (let i = 0; i < 256; i++) {
            layout = ok(insert_columns(layout, scol(0), 'after', [`p${i}`]));
            layout = ok(delete_columns(layout, [pcol(`p${i}`)], () => i));
        }
        expect(layout.columns.length).toBe(MAX_COLUMN_LAYOUT_ENTRIES);
        expect(refusal(insert_columns(layout, scol(0), 'after', ['q']))).toBe('too-many-column-entries');
    });

    it('refuses every column operation on a source wider than 256 columns', () => {
        const wide = source_column_layout(300);
        expect(refusal(insert_columns(wide, scol(0), 'after', ['a']))).toBe('too-wide-to-restructure');
        expect(refusal(delete_columns(wide, [scol(0)], () => 0))).toBe('too-wide-to-restructure');
        expect(refusal(move_columns(wide, [scol(0)], 'end'))).toBe('too-wide-to-restructure');
    });
});

// ---------------------------------------------------------------------------
// Index, segments, moved detection, save maps
// ---------------------------------------------------------------------------

describe('index', () => {
    // Header Row 0: body rows 1..6. Full order: 1 2x a bx 3 6 4 5
    const layout = (() => {
        let next = ok(move_rows(source_row_layout(1, 6), [src(6)], src(4)));
        next = ok(insert_rows(next, src(2), 'after', ['a', 'b']));
        next = ok(delete_rows(next, [src(2), pen('b')], () => 3));
        return next;
    })();
    const index = index_row_layout(layout);

    it('maps positions, statuses, body indexes, and display indexes', () => {
        expect(expand_rows(layout)).toEqual(['1', '2x', 'a', 'bx', '3', '6', '4', '5']);
        expect(index.entryCount).toBe(8);
        expect(index.liveCount).toBe(6);
        expect(index.displayCount).toBe(7);
        expect(index.position_of(src(6))).toBe(5);
        expect(index.position_of(pen('b'))).toBe(3);
        expect(index.position_of(src(7))).toBeUndefined();
        expect(index.position_of(src(0))).toBeUndefined();
        expect(index.status_of(src(2))).toBe('removed');
        expect(index.status_of(pen('b'))).toBe('discarded');
        expect(index.status_of(pen('a'))).toBe('live');
        expect(index.body_index_of(src(1))).toBe(1);
        expect(index.body_index_of(pen('a'))).toBe(2);
        expect(index.body_index_of(src(6))).toBe(4);
        expect(index.body_index_of(src(2))).toBeUndefined();
        expect(index.identity_at_body_index(4)).toEqual(src(6));
        expect(index.identity_at_body_index(0)).toBeUndefined();
        expect(index.identity_at_body_index(7)).toBeUndefined();
        expect(index.display_index_of(src(2))).toBe(1);
        expect(index.display_index_of(pen('b'))).toBeUndefined();
        expect(index.display_index_of(src(6))).toBe(4);
        expect(index.identity_at_display_index(4)).toEqual(src(6));
        expect([...index.display_identities()].map(row_token)).toEqual(['1', '2', 'a', '3', '6', '4', '5']);
    });

    it('finds live entries in intervals and counts live entries before a position', () => {
        expect(index.live_count_before(0)).toBe(0);
        expect(index.live_count_before(2)).toBe(1);
        expect(index.live_count_before(5)).toBe(3);
        expect(index.live_count_before(99)).toBe(6);
        expect(index.first_live_between(1, 1)).toBeUndefined();
        expect(index.first_live_between(1, 3)).toEqual(pen('a'));
        expect(index.last_live_between(1, 4)).toEqual(src(3));
        expect(index.last_live_between(1, 3)).toEqual(pen('a'));
        expect(index.last_live_between(3, 3)).toBeUndefined();
        expect(index.first_live_between(3, 7)).toEqual(src(3));
        expect(index.first_live_between(5, 7)).toEqual(src(6));
    });

    it('reports inserts, out-of-order runs, and displaced runs', () => {
        expect(index.hasLiveInserted).toBe(true);
        expect(index.hasDiscarded).toBe(true);
        expect(index.hasOutOfOrderRun).toBe(true);
        expect(index.hasInsertOrOutOfOrderRun).toBe(true);
        // Source runs in order: [1-2] [3] [6] [4-5]; 6 and 4-5 are out of order with each other.
        expect(index.in_displaced_source_run(src(6))).toBe(true);
        expect(index.in_displaced_source_run(src(4))).toBe(true);
        expect(index.in_displaced_source_run(src(3))).toBe(false);
        expect(index.in_displaced_source_run(src(2))).toBe(false);
        expect(index.in_displaced_source_run(pen('a'))).toBe(false);
        const plain = index_row_layout(source_row_layout(0, 3));
        expect(plain.hasInsertOrOutOfOrderRun).toBe(false);
        expect(plain.hasOutOfOrderRun).toBe(false);
    });

    it('displaced runs skip pending runs to find the nearest source run', () => {
        const skip = index_row_layout(rows_from(['0', '1', 'a', '3', 'b', '2', '4']));
        expect(skip.in_displaced_source_run(src(3))).toBe(true);
        expect(skip.in_displaced_source_run(src(2))).toBe(true);
        expect(skip.in_displaced_source_run(src(0))).toBe(false);
        expect(skip.in_displaced_source_run(src(4))).toBe(false);
    });

    it('partitions the full order into live segments', () => {
        expect(index.segments.map((segment) => segment.kind === 'source'
            ? `${segment.start}+${segment.count}:${segment.status}@${segment.position}/${segment.liveBefore}/${segment.displayBefore}`
            : `${segment.id}:${segment.status}@${segment.position}/${segment.liveBefore}/${segment.displayBefore}`))
            .toEqual([
                '1+1:live@0/0/0',
                '2+1:removed@1/1/1',
                'a:live@2/1/2',
                'b:discarded@3/2/3',
                '3+1:live@4/2/3',
                '6+1:live@5/3/4',
                '4+2:live@6/4/5',
            ]);
    });

    it('indexes columns the same way', () => {
        const columns = index_column_layout(columns_from(['0', 'a', '2x', '1', 'bx']));
        expect(columns.liveCount).toBe(3);
        expect(columns.body_index_of(scol(1))).toBe(3);
        expect(columns.identity_at_body_index(2)).toEqual(pcol('a'));
        expect(columns.position_of(pcol('b'))).toBe(4);
        expect(columns.display_index_of(pcol('b'))).toBeUndefined();
        expect(columns.in_displaced_source_run(scol(2))).toBe(true);
        expect(columns.segments.length).toBe(5);
    });
});

describe('moved detection', () => {
    it('tints the row moved below its neighbor, not the neighbor (ties toward earlier runs)', () => {
        // Rows are 1-based labels over a header-less body: "row 3" is source row 2.
        const layout = ok(move_rows(source_row_layout(0, 6), [src(2)], src(4)));
        expect(expand_rows(layout)).toEqual(['0', '1', '3', '2', '4', '5']);
        expect(moved_source_rows(layout)).toEqual([{ start: 2, count: 1 }]);
    });

    it('moving rows 3-5 below row 6 marks the old row 6', () => {
        const layout = ok(move_rows(source_row_layout(0, 8), [src(2), src(3), src(4)], src(6)));
        expect(expand_rows(layout)).toEqual(['0', '1', '5', '2', '3', '4', '6', '7']);
        expect(moved_source_rows(layout)).toEqual([{ start: 5, count: 1 }]);
        const index = index_row_layout(layout);
        expect(index.body_index_of(src(5))).toBe(3);
    });

    it('ignores removed rows and pending rows', () => {
        const layout = rows_from(['0', '4x', '1', 'a', '2', '3']);
        expect(moved_source_rows(layout)).toEqual([]);
        const partly = rows_from(['0', '4', '5x', '1', '2', '3']);
        expect(moved_source_rows(partly)).toEqual([{ start: 4, count: 1 }]);
    });

    it('applies the same rule to columns', () => {
        expect(moved_source_columns(columns_from(['1', '0', '2']))).toEqual([{ start: 0, count: 1 }]);
        expect(moved_source_columns(columns_from(['2', '3', '0', '1', '4']))).toEqual([{ start: 0, count: 2 }]);
        expect(moved_source_columns(source_column_layout(3))).toEqual([]);
    });
});

describe('save maps', () => {
    it('maps every live source run, removals, and inserted rows to 0-based body indexes', () => {
        // Header Row 0; body rows 1..6. Full order: 1 2x a bx 3 6 4 5
        let layout = ok(move_rows(source_row_layout(1, 6), [src(6)], src(4)));
        layout = ok(insert_rows(layout, src(2), 'after', ['a', 'b']));
        layout = ok(delete_rows(layout, [src(2), pen('b')], () => 3));
        expect(row_save_map(layout)).toEqual({
            rowRuns: [
                { sourceRow: 1, count: 1, bodyIndex: 0 },
                { sourceRow: 3, count: 1, bodyIndex: 2 },
                { sourceRow: 4, count: 2, bodyIndex: 4 },
                { sourceRow: 6, count: 1, bodyIndex: 3 },
            ],
            removedRows: [{ start: 2, count: 1 }],
            insertedRows: [{ pendingRowId: 'a', bodyIndex: 1 }],
        });
    });

    it('lists unmoved rows, shifted or not, and joins runs only split by tombstones', () => {
        const layout = rows_from(['0', '1', 'ax', '2', '3']);
        expect(row_save_map(layout).rowRuns).toEqual([{ sourceRow: 0, count: 4, bodyIndex: 0 }]);
        const shifted = rows_from(['b', '0', '1']);
        expect(row_save_map(shifted).rowRuns).toEqual([{ sourceRow: 0, count: 2, bodyIndex: 1 }]);
        expect(row_save_map(source_row_layout(1, 0))).toEqual({ rowRuns: [], removedRows: [], insertedRows: [] });
    });

    it('maps columns by old index', () => {
        const layout = columns_from(['2', 'a', '0x', '1', 'bx']);
        expect(column_save_map(layout)).toEqual({
            columnMap: [null, 2, 0],
            insertedColumns: [{ pendingColumnId: 'a', column: 1 }],
        });
    });
});

// ---------------------------------------------------------------------------
// Generated sequences against a naive array model
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface NaiveEntry {
    readonly token: string; // number for source, id for pending
    readonly source: boolean;
    status: 'live' | 'removed' | 'discarded';
}

const naive_key = (entry: NaiveEntry): string =>
    entry.status === 'live' ? entry.token : `${entry.token}x`;

function naive_insert(model: NaiveEntry[], anchor: string, side: 'before' | 'after', ids: readonly string[]): boolean {
    const at = model.findIndex((entry) => entry.token === anchor);
    if (at < 0 || model[at]!.status !== 'live') return false;
    let insert_at = side === 'before' ? at : at + 1;
    if (side === 'after') while (insert_at < model.length && model[insert_at]!.status !== 'live') insert_at++;
    model.splice(insert_at, 0, ...ids.map((id): NaiveEntry => ({ token: id, source: false, status: 'live' })));
    return true;
}

function naive_move(model: NaiveEntry[], selection: ReadonlySet<string>, before: string | 'end'): boolean {
    const moved: boolean[] = [];
    let last = false;
    let any = false;
    for (const entry of model) {
        if (entry.status === 'live') {
            last = selection.has(entry.token);
            any ||= last;
        }
        moved.push(last && (entry.status === 'live' ? selection.has(entry.token) : true));
    }
    if (!any) return false;
    let target = before === 'end' ? model.length : model.findIndex((entry) => entry.token === before);
    while (target < model.length && (model[target]!.status !== 'live' || moved[target])) target++;
    const target_entry = model[target];
    const moving = model.filter((_, index) => moved[index]);
    const staying = model.filter((_, index) => !moved[index]);
    const at = target_entry === undefined ? staying.length : staying.indexOf(target_entry);
    model.splice(0, model.length, ...staying.slice(0, at), ...moving, ...staying.slice(at));
    return true;
}

/** For each tombstone, the live token it is glued to ('^' for the start), grouped in order. */
function glue_groups(tokens: readonly string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    let glue = '^';
    for (const token of tokens) {
        if (!token.endsWith('x')) {
            glue = token;
            continue;
        }
        groups.set(glue, [...(groups.get(glue) ?? []), token]);
    }
    return groups;
}

function live_order(tokens: readonly string[]): string[] {
    return tokens.filter((token) => !token.endsWith('x'));
}

/** Canonical runs of a naive full order, for the displaced-run oracle. */
function naive_runs(model: readonly NaiveEntry[]): { source: boolean; start: number; members: number[] }[] {
    const runs: { source: boolean; start: number; members: number[] }[] = [];
    model.forEach((entry, index) => {
        const last = runs[runs.length - 1];
        if (entry.source) {
            const value = Number(entry.token);
            const previous = index > 0 ? model[index - 1] : undefined;
            if (last?.source && previous?.source && Number(previous.token) + 1 === value) last.members.push(index);
            else runs.push({ source: true, start: value, members: [index] });
        } else if (last !== undefined && !last.source) last.members.push(index);
        else runs.push({ source: false, start: -1, members: [index] });
    });
    return runs;
}

function brute_force_lis(values: readonly number[]): number {
    const best = values.map(() => 1);
    let max = 0;
    for (let i = 0; i < values.length; i++) {
        for (let j = 0; j < i; j++) if (values[j]! < values[i]! && best[j]! + 1 > best[i]!) best[i] = best[j]! + 1;
        max = Math.max(max, best[i]!);
    }
    return max;
}

function check_axis_index<I>(
    index: import('../worksheet-layout').AxisLayoutIndex<I>,
    model: readonly NaiveEntry[],
    identity: (entry: NaiveEntry) => I,
    token: (identity: I) => string,
    random: () => number,
): void {
    const live = model.filter((entry) => entry.status === 'live');
    const displayed = model.filter((entry) => entry.status !== 'discarded');
    expect(index.entryCount).toBe(model.length);
    expect(index.liveCount).toBe(live.length);
    expect(index.displayCount).toBe(displayed.length);
    expect(index.hasLiveInserted).toBe(live.some((entry) => !entry.source));
    expect(index.hasDiscarded).toBe(model.some((entry) => entry.status === 'discarded'));
    const runs = naive_runs(model);
    const source_runs = runs.filter((run) => run.source);
    expect(index.hasOutOfOrderRun).toBe(source_runs.some((run, i) => i > 0 && source_runs[i - 1]!.start > run.start));
    const displaced = new Set<number>();
    source_runs.forEach((run, i) => {
        const previous = source_runs[i - 1];
        const next = source_runs[i + 1];
        if ((previous !== undefined && previous.start > run.start) || (next !== undefined && next.start < run.start)) {
            for (const member of run.members) displaced.add(member);
        }
    });
    let live_rank = 0;
    let display_rank = 0;
    model.forEach((entry, position) => {
        const id = identity(entry);
        expect(index.position_of(id)).toBe(position);
        expect(token(index.identity_at_position(position)!)).toBe(entry.token);
        expect(index.status_of(id)).toBe(entry.status);
        expect(index.live_count_before(position)).toBe(live_rank);
        expect(index.in_displaced_source_run(id)).toBe(displaced.has(position));
        if (entry.status === 'live') {
            live_rank++;
            expect(index.body_index_of(id)).toBe(live_rank);
            expect(token(index.identity_at_body_index(live_rank)!)).toBe(entry.token);
        } else {
            expect(index.body_index_of(id)).toBeUndefined();
        }
        if (entry.status !== 'discarded') {
            expect(index.display_index_of(id)).toBe(display_rank);
            expect(token(index.identity_at_display_index(display_rank)!)).toBe(entry.token);
            display_rank++;
        } else {
            expect(index.display_index_of(id)).toBeUndefined();
        }
    });
    expect(index.live_count_before(model.length)).toBe(live.length);
    expect(index.identity_at_position(model.length)).toBeUndefined();
    expect(index.identity_at_body_index(live.length + 1)).toBeUndefined();
    expect(index.identity_at_display_index(displayed.length)).toBeUndefined();
    expect([...index.display_identities()].map(token)).toEqual(displayed.map((entry) => entry.token));
    for (let trial = 0; trial < 6; trial++) {
        const a = Math.floor(random() * (model.length + 1));
        const b = Math.floor(random() * (model.length + 1));
        const [first, last] = a <= b ? [a, b] : [b, a];
        const inside = model.slice(first, last + 1).filter((entry) => entry.status === 'live');
        const first_live = index.first_live_between(first, last);
        const last_live = index.last_live_between(first, last);
        expect(first_live === undefined ? undefined : token(first_live)).toBe(inside[0]?.token);
        expect(last_live === undefined ? undefined : token(last_live)).toBe(inside[inside.length - 1]?.token);
    }
    // Segments cover the full order in place, each homogeneous and maximal within its run.
    const covered: string[] = [];
    index.segments.forEach((segment, i) => {
        expect(segment.position).toBe(covered.length);
        if (segment.kind === 'source') {
            for (let offset = 0; offset < segment.count; offset++) {
                covered.push(segment.status === 'live' ? String(segment.start + offset) : `${segment.start + offset}x`);
            }
            const previous = index.segments[i - 1];
            if (previous?.kind === 'source' && previous.run === segment.run) {
                expect(previous.status).not.toBe(segment.status);
            }
        } else {
            covered.push(segment.status === 'live' ? segment.id : `${segment.id}x`);
        }
    });
    expect(covered).toEqual(model.map(naive_key));
}

function check_moved(moved: readonly { start: number; count: number }[], model: readonly NaiveEntry[]): void {
    const live_sources = model.filter((entry) => entry.status === 'live' && entry.source).map((entry) => Number(entry.token));
    const moved_set = new Set<number>();
    for (const entry of moved) for (let value = entry.start; value < entry.start + entry.count; value++) moved_set.add(value);
    for (const value of moved_set) expect(live_sources).toContain(value);
    const kept = live_sources.filter((value) => !moved_set.has(value));
    // Kept rows are in order, and they are as many as possible.
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(kept.length).toBe(brute_force_lis(live_sources));
}

describe('generated row sequences', () => {
    for (let seed = 1; seed <= 60; seed++) {
        it(`seed ${seed}`, () => {
            const random = mulberry32(seed);
            const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
            const body_start = pick([0, 1, 3]);
            const body_count = Math.floor(random() * 14);
            let layout = source_row_layout(body_start, body_count);
            const model: NaiveEntry[] = Array.from({ length: body_count }, (_, i) => ({
                token: String(body_start + i),
                source: true,
                status: 'live' as const,
            }));
            const orders = new Map<string, number>();
            let next_id = 0;
            let next_order = 0;
            const identity_of = (entry: NaiveEntry): RowIdentity =>
                entry.source ? src(Number(entry.token)) : pen(entry.token);
            const check = (): void => {
                const live_pending = model.filter((entry) => !entry.source && entry.status === 'live');
                const context: RowLayoutContext = {
                    bodyStart: body_start,
                    bodyRowCount: body_count,
                    pendingRows: live_pending.map((entry) => ({ id: entry.token, origin: 'insert', createdOrder: orders.get(entry.token)! })),
                    mintedAsInsert: (id) => orders.has(id),
                };
                expect(validate_row_layout(layout, context)).toBeUndefined();
                expect(expand_rows(layout)).toEqual(model.map(naive_key));
                expect(row_layouts_equal(layout, canonical_row_layout(layout))).toBe(true);
                expect(JSON.stringify(layout)).toBe(JSON.stringify(canonical_row_layout(layout)));
                const index = index_row_layout(layout);
                check_axis_index(index, model, identity_of, row_token, random);
                check_moved(moved_source_rows(layout), model);
                const map = row_save_map(layout);
                const live = model.filter((entry) => entry.status === 'live');
                const mapped = new Map<number, number>();
                let previous = -1;
                for (const entry of map.rowRuns) {
                    expect(entry.sourceRow).toBeGreaterThan(previous);
                    previous = entry.sourceRow + entry.count - 1;
                    for (let offset = 0; offset < entry.count; offset++) mapped.set(entry.sourceRow + offset, entry.bodyIndex + offset);
                }
                expect(mapped.size).toBe(live.filter((entry) => entry.source).length);
                live.forEach((entry, rank) => {
                    if (entry.source) expect(mapped.get(Number(entry.token))).toBe(rank);
                });
                expect(map.insertedRows).toEqual(live.flatMap((entry, rank) => entry.source ? [] : [{ pendingRowId: entry.token, bodyIndex: rank }]));
                expect(has_live_row_layout_change(layout)).toBe(
                    model.some((entry) => entry.status === 'removed' || (!entry.source && entry.status === 'live'))
                    || index.hasOutOfOrderRun);
                expect(is_source_row_layout(layout)).toBe(row_layouts_equal(layout, source_row_layout(body_start, body_count)));
            };
            check();
            for (let step = 0; step < 40; step++) {
                const before_tokens = model.map(naive_key);
                const roll = random();
                if (roll < 0.25) {
                    const anchor = model.length === 0 ? undefined : pick(model);
                    const side = pick(['before', 'after'] as const);
                    const ids = Array.from({ length: 1 + Math.floor(random() * 3) }, () => `n${next_id++}`);
                    if (anchor === undefined) continue;
                    const result = insert_rows(layout, identity_of(anchor), side, ids);
                    const accepted = naive_insert(model, anchor.token, side, ids);
                    expect(result.ok).toBe(accepted);
                    if (!result.ok) {
                        expect(result.refusal.reason).toBe('no-live-entry');
                        continue;
                    }
                    for (const id of ids) orders.set(id, next_order++);
                    layout = result.layout;
                    const after_tokens = model.map(naive_key);
                    expect(glue_groups(after_tokens)).toEqual(glue_groups(before_tokens));
                    const expected_live = live_order(before_tokens);
                    expected_live.splice(expected_live.indexOf(anchor.token) + (side === 'after' ? 1 : 0), 0, ...ids);
                    expect(live_order(after_tokens)).toEqual(expected_live);
                } else if (roll < 0.45) {
                    if (model.length === 0) continue;
                    const chosen = model.filter(() => random() < 0.3);
                    layout = ok(delete_rows(layout, chosen.map(identity_of), (id) => orders.get(id)!));
                    for (const entry of chosen) {
                        if (entry.status === 'live') entry.status = entry.source ? 'removed' : 'discarded';
                    }
                } else if (roll < 0.55) {
                    const removed = model.filter((entry) => entry.status === 'removed');
                    if (removed.length === 0) continue;
                    const chosen = removed.filter(() => random() < 0.5);
                    layout = ok(restore_rows(layout, chosen.map((entry) => Number(entry.token))));
                    for (const entry of chosen) entry.status = 'live';
                } else if (roll < 0.9) {
                    if (model.length === 0) continue;
                    const start = Math.floor(random() * model.length);
                    const length = 1 + Math.floor(random() * 4);
                    const block = model.slice(start, start + length);
                    const before = random() < 0.15 ? 'end' : pick(model).token;
                    const before_entry = model.find((entry) => entry.token === before);
                    const result = move_rows(
                        layout,
                        block.map(identity_of),
                        before === 'end' ? 'end' : identity_of(before_entry!),
                    );
                    const selection = new Set(block.filter((entry) => entry.status === 'live').map((entry) => entry.token));
                    const accepted = naive_move(model, selection, before);
                    expect(result.ok).toBe(accepted);
                    if (!result.ok) {
                        expect(result.refusal.reason).toBe('no-live-entry');
                        continue;
                    }
                    layout = result.layout;
                    const after_tokens = model.map(naive_key);
                    expect(glue_groups(after_tokens)).toEqual(glue_groups(before_tokens));
                    // Expected live order, independent of tombstones.
                    const live_before = live_order(before_tokens);
                    const position_of_before = before === 'end' ? before_tokens.length : before_tokens.findIndex((token) => token.replace(/x$/, '') === before);
                    const target = before_tokens.slice(position_of_before).find((token) => !token.endsWith('x') && !selection.has(token));
                    const staying = live_before.filter((token) => !selection.has(token));
                    const moving = live_before.filter((token) => selection.has(token));
                    const at = target === undefined ? staying.length : staying.indexOf(target);
                    expect(live_order(after_tokens)).toEqual([...staying.slice(0, at), ...moving, ...staying.slice(at)]);
                } else if (roll < 0.95) {
                    const live = model.filter((entry) => entry.status === 'live');
                    if (live.length === 0) continue;
                    const start = Math.floor(random() * live.length);
                    const block = live.slice(start, start + 1 + Math.floor(random() * 3));
                    const direction = pick(['backward', 'forward'] as const);
                    const target = step_move_target(index_row_layout(layout), block.map(identity_of), direction);
                    const live_tokens = live.map((entry) => entry.token);
                    const first = live_tokens.indexOf(block[0]!.token);
                    const last = live_tokens.indexOf(block[block.length - 1]!.token);
                    if (direction === 'backward' ? first === 0 : last === live_tokens.length - 1) {
                        expect(target).toBeUndefined();
                        continue;
                    }
                    layout = ok(move_rows(layout, block.map(identity_of), target!));
                    naive_move(model, new Set(block.map((entry) => entry.token)), target === 'end' ? 'end' : row_token(target!));
                    const expected = [...live_tokens];
                    const moving = expected.splice(first, block.length);
                    expected.splice(direction === 'backward' ? first - 1 : first + 1, 0, ...moving);
                    expect(live_order(model.map(naive_key))).toEqual(expected);
                } else {
                    const keep = new Set(model.filter((entry) => entry.status === 'discarded' && random() < 0.5).map((entry) => entry.token));
                    layout = drop_unreferenced_row_tombstones(layout, (id) => keep.has(id));
                    for (let i = model.length - 1; i >= 0; i--) {
                        if (model[i]!.status === 'discarded' && !keep.has(model[i]!.token)) model.splice(i, 1);
                    }
                }
                check();
            }
        });
    }
});

describe('generated column sequences', () => {
    for (let seed = 1; seed <= 40; seed++) {
        it(`seed ${seed}`, () => {
            const random = mulberry32(1000 + seed);
            const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
            const count = Math.floor(random() * 10);
            let layout = source_column_layout(count);
            const model: NaiveEntry[] = Array.from({ length: count }, (_, i) => ({ token: String(i), source: true, status: 'live' as const }));
            const orders = new Map<string, number>();
            let next_id = 0;
            const identity_of = (entry: NaiveEntry): ColumnIdentity =>
                entry.source ? scol(Number(entry.token)) : pcol(entry.token);
            const check = (): void => {
                const context: ColumnLayoutContext = {
                    sourceColumnCount: count,
                    pendingColumns: model
                        .filter((entry) => !entry.source && entry.status === 'live')
                        .map((entry) => ({ id: entry.token, createdOrder: orders.get(entry.token)! })),
                };
                expect(validate_column_layout(layout, context)).toBeUndefined();
                expect(expand_columns(layout)).toEqual(model.map(naive_key));
                check_axis_index(index_column_layout(layout), model, identity_of, column_token, random);
                check_moved(moved_source_columns(layout), model);
                const map = column_save_map(layout);
                const live = model.filter((entry) => entry.status === 'live');
                const expected_map = Array.from({ length: count }, (): number | null => null);
                live.forEach((entry, rank) => {
                    if (entry.source) expected_map[Number(entry.token)] = rank;
                });
                expect(map.columnMap).toEqual(expected_map);
                expect(map.insertedColumns).toEqual(live.flatMap((entry, rank) => entry.source ? [] : [{ pendingColumnId: entry.token, column: rank }]));
            };
            check();
            for (let step = 0; step < 30; step++) {
                const before_tokens = model.map(naive_key);
                const roll = random();
                if (model.length === 0) break;
                if (roll < 0.3) {
                    const anchor = pick(model);
                    const side = pick(['before', 'after'] as const);
                    const ids = [`c${next_id++}`];
                    const result = insert_columns(layout, identity_of(anchor), side, ids);
                    expect(result.ok).toBe(naive_insert(model, anchor.token, side, ids));
                    if (!result.ok) continue;
                    orders.set(ids[0]!, next_id);
                    layout = result.layout;
                    expect(glue_groups(model.map(naive_key))).toEqual(glue_groups(before_tokens));
                } else if (roll < 0.5) {
                    const chosen = model.filter(() => random() < 0.3);
                    layout = ok(delete_columns(layout, chosen.map(identity_of), (id) => orders.get(id)!));
                    for (const entry of chosen) {
                        if (entry.status === 'live') entry.status = entry.source ? 'removed' : 'discarded';
                    }
                } else if (roll < 0.6) {
                    const chosen = model.filter((entry) => entry.status === 'removed' && random() < 0.5);
                    layout = ok(restore_columns(layout, chosen.map((entry) => Number(entry.token))));
                    for (const entry of chosen) entry.status = 'live';
                } else if (roll < 0.95) {
                    const start = Math.floor(random() * model.length);
                    const block = model.slice(start, start + 1 + Math.floor(random() * 3));
                    const before = random() < 0.15 ? 'end' : pick(model).token;
                    const before_entry = model.find((entry) => entry.token === before);
                    const result = move_columns(layout, block.map(identity_of), before === 'end' ? 'end' : identity_of(before_entry!));
                    const selection = new Set(block.filter((entry) => entry.status === 'live').map((entry) => entry.token));
                    expect(result.ok).toBe(naive_move(model, selection, before));
                    if (!result.ok) continue;
                    layout = result.layout;
                    expect(glue_groups(model.map(naive_key))).toEqual(glue_groups(before_tokens));
                } else {
                    layout = drop_unreferenced_column_tombstones(layout, () => false);
                    for (let i = model.length - 1; i >= 0; i--) if (model[i]!.status === 'discarded') model.splice(i, 1);
                }
                check();
            }
        });
    }
});
