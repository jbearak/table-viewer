/**
 * A highlight gesture, from the host's delta to the request the host is sent
 * back. The pieces are unit-tested individually; this is the seam between them —
 * that what capture records is what replay asks for, in the right direction.
 */
import { describe, expect, it } from 'vitest';
import { highlight_history_source } from '../webview/highlight-capture-model';
import { highlight_state_deltas } from '../highlight-delta';
import { create_history_store } from '../webview/history-store';
import { peek_history } from '../webview/history-stack-model';
import { build_prepare_request } from '../webview/history-replay-request-model';
import { plan_history_replay } from '../webview/history-replay-model';
import { absent_overlay } from '../webview/history-cell-state-model';
import type { CellHighlightState, WorksheetTarget } from '../types';

const SHEETS = [{ name: 'Data', worksheetId: 'rId1' }];
const TARGET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };

function state(cells: Record<string, string>): CellHighlightState {
    return {
        sourceDigest: 'digest',
        sheets: [{ schema: 'schema-1', cells: cells as never }],
    };
}

/** Capture a gesture the way App does: the host's delta, then the history source. */
function record(before: CellHighlightState | undefined, after: CellHighlightState) {
    const store = create_history_store();
    const staged = store.stage_record({
        label: 'Highlight cells',
        changes: highlight_history_source(
            [...highlight_state_deltas(before, after)],
            SHEETS,
        ),
    });
    staged.commit();
    staged.notify();
    return store;
}

describe('a highlight gesture through to its replay', () => {
    it('asks the host to put back the colour the cell had, undoing', () => {
        const store = record(state({}), state({ '2:3': 'yellow' }));
        const peek = peek_history(store.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('nothing recorded');

        const request = build_prepare_request(peek.entry, 'undo', {
            read_overlay: () => absent_overlay(),
            next_id: (prefix) => prefix,
        });

        // No cells: a highlight gesture writes no pending-edit state, which is what
        // exempts it from needing an edit session.
        expect(request?.cells).toEqual([]);
        // Undo expects to find what the gesture produced, and desires what preceded
        // it. Getting these backwards would overwrite a colour someone else set.
        expect(request?.highlights).toEqual([{
            ordinal: 0,
            worksheet: TARGET,
            sourceRow: 2,
            sourceColumn: 3,
            expected: 'yellow',
            desired: null,
        }]);
        // And the cursor is sent to the cell the gesture touched.
        expect(request?.focus).toMatchObject({
            worksheet: TARGET,
            sourceRowStart: 2,
            sourceColumnStart: 3,
        });
    });

    it('reverses the same transition for redo', () => {
        const store = record(state({}), state({ '2:3': 'yellow' }));
        const undo = peek_history(store.snapshot(), 'undo');
        if (undo.kind !== 'available') throw new Error('nothing recorded');
        const request = build_prepare_request(undo.entry, 'redo', {
            read_overlay: () => absent_overlay(),
            next_id: (prefix) => prefix,
        });
        expect(request?.highlights[0]).toMatchObject({ expected: null, desired: 'yellow' });
    });

    it('plans a highlight-only replay with no writes and no cell reads', () => {
        const store = record(state({ '0:0': 'blue' }), state({ '0:0': 'green' }));
        const peek = peek_history(store.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('nothing recorded');

        const plan = plan_history_replay(peek.entry.action, 'undo', () => {
            throw new Error('a highlight replay must not read cell state');
        });

        expect(plan.kind).toBe('plan');
        if (plan.kind !== 'plan') throw new Error('unreachable');
        expect(plan.writes).toEqual([]);
        expect(plan.highlights).toEqual([expect.objectContaining({
            before: 'blue',
            after: 'green',
        })]);
    });

    it('records one action spanning every cell a clear-all touched', () => {
        // One gesture, so one undo — not one per cell.
        const store = record(state({ '0:0': 'yellow', '1:1': 'blue', '2:2': 'green' }), state({}));
        const peek = peek_history(store.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('nothing recorded');
        expect(peek.entry.action.changes).toHaveLength(3);
        expect(peek.entry.action.changes.every((change) => change.kind === 'highlight')).toBe(true);
    });

    it('records nothing for a gesture that changed no colour', () => {
        const unchanged = state({ '0:0': 'yellow' });
        const store = record(unchanged, unchanged);
        expect(peek_history(store.snapshot(), 'undo').kind).not.toBe('available');
    });
});
