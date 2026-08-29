import { describe, expect, it } from 'vitest';
import type { CellHighlightColor, WorksheetTarget } from '../types';
import type { RichText } from '../cell-content';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
    type CellOverlayState,
} from '../webview/history-cell-state-model';
import {
    peek_history,
    type HistoryAction,
    type HistoryChange,
    type HistoryEntry,
} from '../webview/history-stack-model';
import { create_history_store } from '../webview/history-store';
import { plan_history_replay, type ReplayPlan } from '../webview/history-replay-model';
import {
    read_state_from_prepared_replay,
    wire_overlay_from_cell_overlay_state,
} from '../webview/history-replay-wire-model';
import {
    build_commit_request,
    build_prepare_request,
    commit_refusal_reason,
    prepare_refusal_reason,
    replayed_store_entry,
    type ReplayRequestSources,
} from '../webview/history-replay-request-model';
import type { HistoryReplayPrepared, PrepareHistoryReplayRequest } from '../history-replay-protocol';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const OTHER: WorksheetTarget = { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' };
const BOLD: RichText = { runs: [{ text: 'typed', style: { bold: true } }] };

/** A cell going from unedited to typed, so undo removes the overlay. */
function cell_change(
    row: number,
    column: number,
    text: string,
    worksheet: WorksheetTarget = SHEET,
): HistoryChange {
    const delta = build_cell_history_delta({
        worksheet,
        sourceRow: row,
        sourceColumn: column,
        before: absent_overlay(),
        after: value_only_overlay(history_value(text), history_value('base')),
        persistedValue: history_value('base'),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return { kind: 'cell', delta };
}

/**
 * A cell whose overlay base was never observed, both before and after: a legacy
 * durable entry retyped. Undoing lands on a base-pending destination.
 */
function pending_base_change(
    before_text: string,
    after_text: string,
    before_runs?: RichText,
    before_move?: {
        readonly movedFrom: { readonly row: number; readonly col: number; readonly order: number };
        readonly valueEditOrder: number;
    },
): HistoryChange {
    const pending = (
        text: string,
        runs?: RichText,
        move?: typeof before_move,
    ) => value_only_overlay(
        history_value(text, runs),
        history_value(''),
        true,
        undefined,
        undefined,
        undefined,
        move?.movedFrom,
        move?.valueEditOrder,
    );
    const delta = build_cell_history_delta({
        worksheet: SHEET,
        sourceRow: 3,
        sourceColumn: 4,
        before: pending(before_text, before_runs, before_move),
        after: pending(after_text),
        persistedValue: history_value(''),
        persistedHyperlink: null,
    });
    if (delta === undefined) throw new Error('fixture built a delta that moved nothing');
    return { kind: 'cell', delta };
}

function highlight_change(
    row: number,
    column: number,
    before: CellHighlightColor | null,
    after: CellHighlightColor | null,
): HistoryChange {
    return {
        kind: 'highlight',
        delta: { worksheet: SHEET, sourceRow: row, sourceColumn: column, before, after },
    };
}

function action(changes: readonly HistoryChange[]): HistoryAction {
    return { label: 'Edit', changes };
}

/**
 * An entry holding one action.
 *
 * Built through the store rather than by hand: `HistoryEntry` carries the epoch
 * and measured costs the stack maintains, and a literal standing in for it would
 * be a fixture asserting against a shape the store does not produce.
 */
function entry(changes: readonly HistoryChange[]): HistoryEntry {
    const store = create_history_store();
    const record = store.stage_record({ label: 'Edit', changes });
    record.commit();
    record.notify();
    const peek = peek_history(store.snapshot(), 'undo');
    if (peek.kind !== 'available') throw new Error('fixture recorded nothing to undo');
    return peek.entry;
}

/**
 * Sources over an overlay map: every cell the action touched currently holds its
 * after-state, so an undo has something consistent to walk back.
 */
function sources(
    changes: readonly HistoryChange[],
    invisible: ReadonlySet<string> = new Set(),
): ReplayRequestSources {
    const overlays = new Map<string, CellOverlayState>();
    for (const change of changes) {
        if (change.kind !== 'cell') continue;
        overlays.set(
            `${change.delta.sourceRow}:${change.delta.sourceColumn}`,
            change.delta.afterOverlay,
        );
    }
    let counter = 0;
    return {
        read_overlay: (_worksheet, row, column) => {
            const key = `${row}:${column}`;
            return invisible.has(key) ? undefined : overlays.get(key) ?? absent_overlay();
        },
        next_id: (prefix) => `${prefix}-${++counter}`,
    };
}

function prepare(
    changes: readonly HistoryChange[],
    direction: 'undo' | 'redo' = 'undo',
    invisible?: ReadonlySet<string>,
): PrepareHistoryReplayRequest | undefined {
    return build_prepare_request(entry(changes), direction, sources(changes, invisible));
}

/** The prepared response a compliant host would send. */
function prepared_for(request: PrepareHistoryReplayRequest): HistoryReplayPrepared {
    return {
        requestId: request.requestId,
        replayId: request.replayId,
        leaseId: 'lease-1',
        focusSheetIndex: request.focus.worksheet.sheetIndex,
        focus: request.focus,
        cells: request.cells.map((cell) => ({
            ordinal: cell.ordinal,
            worksheet: cell.worksheet,
            resolvedSheetIndex: cell.worksheet.sheetIndex,
            sourceRow: cell.sourceRow,
            sourceColumn: cell.sourceColumn,
            overlay: cell.overlay,
            persisted: { text: 'base' },
            persistedHyperlink: null,
        })),
    };
}

function plan_for(
    changes: readonly HistoryChange[],
    prepared: HistoryReplayPrepared,
    direction: 'undo' | 'redo' = 'undo',
): ReplayPlan {
    const result = plan_history_replay(
        action(changes),
        direction,
        read_state_from_prepared_replay(prepared),
    );
    if (result.kind !== 'plan') throw new Error(`fixture plan refused: ${result.reason}`);
    return result;
}

describe('build_prepare_request', () => {
    it('assigns dense cell ordinals in replay order', () => {
        const changes = [cell_change(0, 0, 'a'), cell_change(5, 2, 'b'), cell_change(9, 1, 'c')];
        const request = prepare(changes);
        expect(request?.cells.map((cell) => cell.ordinal)).toEqual([0, 1, 2]);
    });

    it('assigns one ordinal per address, not per change', () => {
        // A paste overlapping its own source touches a cell twice, and both
        // deltas compare-and-swap against the one cell.
        const request = prepare([cell_change(0, 0, 'a'), cell_change(0, 0, 'b')]);
        expect(request?.cells).toHaveLength(1);
        expect(request?.cells[0]?.ordinal).toBe(0);
    });

    it('sends the cell current overlay, not the side the action recorded', () => {
        const changes = [cell_change(3, 4, 'typed')];
        const request = prepare(changes);
        // The recorded before-side is absent; the cell currently holds the after.
        expect(request?.cells[0]?.overlay.kind).toBe('present');
    });

    it('refuses when a cell overlay cannot be read', () => {
        expect(prepare([cell_change(0, 0, 'a')], 'undo', new Set(['0:0']))).toBeUndefined();
    });

    it('builds a highlight-only request, which has no cells at all', () => {
        // Highlights are durable workbook state, not session-owned pending edits,
        // so a gesture that only painted cells is replayable with an empty cell
        // list — and, on the host side, with no edit session.
        const request = prepare([highlight_change(4, 5, null, 'yellow')]);
        expect(request?.cells).toEqual([]);
        expect(request?.highlights).toHaveLength(1);
        // Focus still lands on the region the gesture touched: it is extended by
        // every change, not only by cells.
        expect(request?.focus).toMatchObject({
            sourceRowStart: 4,
            sourceRowEnd: 4,
            sourceColumnStart: 5,
            sourceColumnEnd: 5,
        });
    });

    it('refuses an action with neither cells nor highlights', () => {
        // Nothing for the host to verify or apply, so a lease would authorize
        // nothing. The recorder refuses an empty gesture upstream, so this cannot
        // arrive through the store — the guard is the request model's own, and is
        // asserted against a hand-built entry for exactly that reason.
        const empty: HistoryEntry = {
            ...entry([cell_change(0, 0, 'a')]),
            action: { label: 'Edit', changes: [] },
        };
        expect(build_prepare_request(empty, 'undo', sources([]))).toBeUndefined();
    });

    describe('highlight expectations', () => {
        it('expects the after side and desires the before side, undoing', () => {
            const request = prepare([
                cell_change(0, 0, 'a'),
                highlight_change(1, 1, null, 'yellow'),
            ]);
            expect(request?.highlights[0]?.expected).toBe('yellow');
            expect(request?.highlights[0]?.desired).toBe(null);
        });

        it('expects the before side and desires the after side, redoing', () => {
            const request = prepare([
                cell_change(0, 0, 'a'),
                highlight_change(1, 1, null, 'yellow'),
            ], 'redo');
            expect(request?.highlights[0]?.expected).toBe(null);
            expect(request?.highlights[0]?.desired).toBe('yellow');
        });

        it('numbers highlights densely and independently of cells', () => {
            const request = prepare([
                cell_change(0, 0, 'a'),
                highlight_change(1, 1, null, 'yellow'),
                highlight_change(2, 2, 'green', null),
            ]);
            expect(request?.highlights.map((entry) => entry.ordinal)).toEqual([0, 1]);
        });
    });

    describe('the focus region', () => {
        it('covers every touched cell on the first worksheet', () => {
            const request = prepare([cell_change(2, 3, 'a'), cell_change(7, 1, 'b')]);
            expect(request?.focus).toMatchObject({
                sourceRowStart: 2,
                sourceRowEnd: 7,
                sourceColumnStart: 1,
                sourceColumnEnd: 3,
            });
        });

        it('ignores cells on other worksheets, which no rectangle could cover', () => {
            // Undo walks the gesture backwards, so the FIRST change in replay
            // order is the action's last — here the one on OTHER, which is
            // therefore the sheet the focus settles on.
            const request = prepare([
                cell_change(2, 2, 'a'),
                cell_change(90, 90, 'b', OTHER),
            ]);
            expect(request?.focus.worksheet.sheetIndex).toBe(OTHER.sheetIndex);
            expect(request?.focus).toMatchObject({ sourceRowStart: 90, sourceRowEnd: 90 });
        });

        it('follows the first replayed change even when it is a highlight', () => {
            const request = prepare([
                cell_change(9, 9, 'a'),
                highlight_change(4, 4, null, 'yellow'),
            ]);
            expect(request?.focus).toMatchObject({ sourceRowStart: 4, sourceRowEnd: 9 });
        });
    });
});

describe('build_commit_request', () => {
    it('covers exactly the prepared cell set', () => {
        const changes = [cell_change(0, 0, 'a'), cell_change(1, 1, 'b')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const commit = build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 0);
        expect(commit?.cells.map((cell) => cell.ordinal)).toEqual([0, 1]);
    });

    it('names writes by the ordinal preparation assigned, never its own index', () => {
        const changes = [cell_change(0, 0, 'a'), cell_change(1, 1, 'b')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const commit = build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 0);
        // Every ordinal is one the preparation published.
        const published = new Set(prepared.cells.map((cell) => cell.ordinal));
        expect(commit?.cells.every((cell) => published.has(cell.ordinal))).toBe(true);
    });

    it('one highlight write per prepared highlight, by ordinal', () => {
        const changes = [
            cell_change(0, 0, 'a'),
            highlight_change(1, 1, null, 'yellow'),
            highlight_change(2, 2, 'green', null),
        ];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const commit = build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 2);
        expect(commit?.highlights.map((entry) => entry.ordinal)).toEqual([0, 1]);
    });

    it('refuses when the plan highlight count disagrees with the prepared one', () => {
        // A mismatch would mean committing a highlight the host verified nothing
        // about, so it is refused rather than trimmed to fit.
        const changes = [cell_change(0, 0, 'a'), highlight_change(1, 1, null, 'yellow')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        expect(build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 2))
            .toBeUndefined();
    });

    it('sends a plain base-pending destination as the bare legacy string', () => {
        // An entry has no field for an unobserved base, so sending one would tell
        // a later save the placeholder base was real. The bare string is the only
        // durable form that records the fact.
        const changes = [pending_base_change('typed', 'retyped')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const commit = build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 0);
        expect(commit?.cells).toEqual([{ ordinal: 0, entry: 'typed' }]);
    });

    it('refuses a base-pending destination no durable shape can hold', () => {
        // Styled text plus an unobserved base: writing it as a bare string would
        // drop the styling, and as an entry would invent the base. Refused, and
        // history is left where it is.
        const changes = [pending_base_change('typed', 'retyped', BOLD)];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        expect(build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 0))
            .toBeUndefined();
    });

    it('refuses to collapse base-pending move metadata into a legacy string', () => {
        const changes = [pending_base_change('typed', 'retyped', undefined, {
            movedFrom: { row: 1, col: 2, order: 7 },
            valueEditOrder: 7,
        })];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);

        expect(build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 0))
            .toBeUndefined();
    });

    it('refuses a planned write the preparation has no ordinal for', () => {
        const changes = [cell_change(0, 0, 'a')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const plan = plan_for(changes, prepared);
        // A preparation covering a different cell than the plan writes.
        const foreign: HistoryReplayPrepared = {
            ...prepared,
            cells: prepared.cells.map((cell) => ({ ...cell, sourceRow: cell.sourceRow + 40 })),
        };
        expect(build_commit_request(foreign, plan, 'm-1', 0)).toBeUndefined();
    });

    it('carries the lease correlation through unchanged', () => {
        const changes = [cell_change(0, 0, 'a')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const commit = build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 0);
        expect(commit).toMatchObject({
            requestId: prepared.requestId,
            replayId: prepared.replayId,
            leaseId: prepared.leaseId,
            mutationId: 'm-1',
        });
    });

    it('gives a prepared cell the plan leaves alone a no-op entry', () => {
        // Two cells prepared, but a plan that writes only one: the untouched cell
        // still gets a write, carrying what its own overlay projects to, so the
        // proposal covers the prepared set without proposing a change.
        const changes = [cell_change(0, 0, 'a'), cell_change(1, 1, 'b')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const full = plan_for(changes, prepared);
        const partial: ReplayPlan = { ...full, writes: full.writes.slice(0, 1) };
        const commit = build_commit_request(prepared, partial, 'm-1', 0);
        expect(commit?.cells).toHaveLength(2);
        // Ordinal 1 is the second cell in REPLAY order, which for an undo is the
        // action's first — the 'a' cell. It keeps its current overlay's value
        // rather than being reverted by omission.
        expect(commit?.cells[1]?.entry).toMatchObject({ value: 'a', base: 'base' });
    });

    it('keeps all value metadata on a prepared cell the plan leaves alone', () => {
        const changes = [cell_change(0, 0, 'a'), cell_change(1, 1, 'b')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const full = plan_for(changes, prepared);
        const partial: ReplayPlan = { ...full, writes: full.writes.slice(0, 1) };
        const overlay = wire_overlay_from_cell_overlay_state(value_only_overlay(
            history_value('a'), history_value('base'), false,
            true, undefined, true, { row: 4, col: 3, order: 7 }, 8,
        ));
        const enriched: HistoryReplayPrepared = {
            ...prepared,
            cells: prepared.cells.map((cell, index) => index === 1 ? {
                ...cell,
                overlay,
                persisted: { text: 'current file' },
            } : cell),
        };

        expect(build_commit_request(enriched, partial, 'm-1', 0)?.cells[1]?.entry)
            .toMatchObject({
                value: 'a',
                base: 'base',
                writeValue: true,
                formattingKnown: true,
                observedBase: { value: 'current file' },
                movedFrom: { row: 4, col: 3, order: 7 },
                valueEditOrder: 8,
            });
    });
});

describe('refusal vocabularies', () => {
    it('maps every prepare refusal the host can send', () => {
        expect(prepare_refusal_reason('busy')).toBe('busy');
        expect(prepare_refusal_reason('conflict')).toBe('conflict');
        expect(prepare_refusal_reason('malformed')).toBe('malformed');
        expect(prepare_refusal_reason('unavailable')).toBe('unavailable');
        expect(prepare_refusal_reason('edit-session-unavailable')).toBe('unavailable');
        expect(prepare_refusal_reason('document-changed')).toBe('document-changed');
    });

    it('maps every commit refusal, reading an expired lease as a moved document', () => {
        expect(commit_refusal_reason('conflict')).toBe('conflict');
        expect(commit_refusal_reason('malformed')).toBe('malformed');
        expect(commit_refusal_reason('proposal-mismatch')).toBe('malformed');
        expect(commit_refusal_reason('unavailable')).toBe('unavailable');
        expect(commit_refusal_reason('expired')).toBe('document-changed');
        expect(commit_refusal_reason('document-changed')).toBe('document-changed');
    });
});

describe('replayed_store_entry', () => {
    it('removes the slot for a null write', () => {
        expect(replayed_store_entry(null)).toBeUndefined();
    });

    it('keeps an entry as it arrived', () => {
        const entry = { value: 'typed', base: 'disk' };
        expect(replayed_store_entry(entry)).toBe(entry);
    });

    it('rehydrates a legacy string with the base still pending', () => {
        // The round trip's other half: without the flag, conflict detection would
        // read the placeholder base as one that was actually observed, and the
        // next save would compare the edit against a base nobody ever saw.
        expect(replayed_store_entry('typed'))
            .toEqual({ value: 'typed', base: '', base_pending: true });
    });

    it('inverts wire_entry_for_destination for a plain base-pending cell', () => {
        const changes = [pending_base_change('typed', 'retyped')];
        const request = prepare(changes)!;
        const prepared = prepared_for(request);
        const commit = build_commit_request(prepared, plan_for(changes, prepared), 'm-1', 0)!;
        expect(replayed_store_entry(commit.cells[0].entry))
            .toEqual({ value: 'typed', base: '', base_pending: true });
    });
});
