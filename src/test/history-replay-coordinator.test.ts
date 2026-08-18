import { describe, expect, it } from 'vitest';
import type { CellHighlightColor, WorksheetTarget } from '../types';
import {
    absent_overlay,
    build_cell_history_delta,
    history_value,
    value_only_overlay,
    type CellOverlayState,
} from '../webview/history-cell-state-model';
import { peek_history, type HistoryChange } from '../webview/history-stack-model';
import { create_history_store } from '../webview/history-store';
import {
    create_history_replay_coordinator,
    type ReplayCoordinatorHost,
    type AcceptedReplay,
    type ReplayOutcome,
} from '../webview/history-replay-coordinator';
import type {
    AbandonHistoryReplayRequest,
    CommitHistoryReplayRequest,
    HistoryReplayPrepared,
    PrepareHistoryReplayRequest,
} from '../history-replay-protocol';
import { wire_overlay_from_cell_overlay_state } from '../webview/history-replay-wire-model';

const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
const OTHER: WorksheetTarget = { sheetIndex: 1, sheetName: 'Notes', worksheetId: 'rId2' };

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

type Posted =
    | { readonly type: 'prepareHistoryReplay'; readonly request: PrepareHistoryReplayRequest }
    | { readonly type: 'commitHistoryReplay'; readonly request: CommitHistoryReplayRequest }
    | { readonly type: 'abandonHistoryReplay'; readonly request: AbandonHistoryReplayRequest };

interface Harness {
    readonly coordinator: ReturnType<typeof create_history_replay_coordinator>;
    readonly posted: Posted[];
    /** The overlay each cell currently holds, keyed `row:col`. */
    readonly overlays: Map<string, CellOverlayState>;
    /** Cells the reader refuses to answer for. */
    readonly invisible: Set<string>;
}

/**
 * A coordinator over a history holding one action.
 *
 * `direction` says which stack the action should be sitting on: a recording lands
 * on the undo stack, so a fixture that wants to test a REDO has to move it across
 * first — there is nothing to redo until something has been undone.
 */
function harness(
    changes: readonly HistoryChange[],
    direction: 'undo' | 'redo' = 'undo',
): Harness {
    const store = create_history_store();
    const record = store.stage_record({ label: 'Edit', changes });
    record.commit();
    record.notify();
    if (direction === 'redo') {
        const peek = peek_history(store.snapshot(), 'undo');
        if (peek.kind !== 'available') throw new Error('fixture recorded nothing to undo');
        const move = store.stage_move('undo', peek.entry);
        move.commit();
        move.notify();
    }

    const posted: Posted[] = [];
    const overlays = new Map<string, CellOverlayState>();
    const invisible = new Set<string>();
    // Every cell the fixture's action touches currently holds the AFTER state, so
    // an undo has something consistent to walk back.
    for (const change of changes) {
        if (change.kind !== 'cell') continue;
        overlays.set(
            `${change.delta.sourceRow}:${change.delta.sourceColumn}`,
            change.delta.afterOverlay,
        );
    }

    let counter = 0;
    const host: ReplayCoordinatorHost = {
        history: () => store.snapshot(),
        read_overlay: (_worksheet, row, column) => {
            const key = `${row}:${column}`;
            return invisible.has(key) ? undefined : overlays.get(key) ?? absent_overlay();
        },
        post: (message) => { posted.push(message); },
        next_id: (prefix) => `${prefix}-${++counter}`,
    };
    return { coordinator: create_history_replay_coordinator(host), posted, overlays, invisible };
}

/** The prepared response a compliant host would send for a prepare request. */
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

function last_prepare(posted: readonly Posted[]): PrepareHistoryReplayRequest {
    const message = [...posted].reverse().find((entry) => entry.type === 'prepareHistoryReplay');
    if (message?.type !== 'prepareHistoryReplay') throw new Error('no prepare was posted');
    return message.request;
}

function last_commit(posted: readonly Posted[]): CommitHistoryReplayRequest {
    const message = [...posted].reverse().find((entry) => entry.type === 'commitHistoryReplay');
    if (message?.type !== 'commitHistoryReplay') throw new Error('no commit was posted');
    return message.request;
}

describe('beginning a replay', () => {
    it('refuses when the history has nothing to replay', async () => {
        const store = create_history_store();
        const coordinator = create_history_replay_coordinator({
            history: () => store.snapshot(),
            read_overlay: () => absent_overlay(),
            post: () => {},
            next_id: (prefix) => prefix,
        });
        await expect(coordinator.begin('undo')).resolves.toEqual({
            kind: 'refused',
            reason: 'nothing-to-replay',
        });
    });

    it('posts a prepare carrying each cell current overlay', () => {
        const { coordinator, posted } = harness([cell_change(3, 4, 'typed')]);
        void coordinator.begin('undo');
        const request = last_prepare(posted);
        expect(request.cells).toHaveLength(1);
        expect(request.cells[0]?.sourceRow).toBe(3);
        // The CURRENT overlay, not the recorded before-side: the host compares it
        // against durable state, so sending the recorded side would prove nothing.
        expect(request.cells[0]?.overlay).toEqual(
            wire_overlay_from_cell_overlay_state(
                value_only_overlay(history_value('typed'), history_value('base')),
            ),
        );
    });

    it('assigns one dense ordinal per address, not per change', () => {
        // A paste overlapping its own source touches a cell twice.
        const { coordinator, posted } = harness([
            cell_change(0, 0, 'first'),
            cell_change(0, 0, 'second'),
            cell_change(1, 0, 'other'),
        ]);
        void coordinator.begin('undo');
        const request = last_prepare(posted);
        expect(request.cells.map((cell) => cell.ordinal)).toEqual([0, 1]);
    });

    it('refuses a second replay while one is outstanding', async () => {
        const { coordinator } = harness([cell_change(0, 0, 'typed')]);
        void coordinator.begin('undo');
        expect(coordinator.is_busy()).toBe(true);
        await expect(coordinator.begin('undo')).resolves.toEqual({
            kind: 'refused',
            reason: 'busy',
        });
    });

    it('refuses when a cell current overlay cannot be read', async () => {
        const { coordinator, invisible } = harness([cell_change(0, 0, 'typed')]);
        invisible.add('0:0');
        await expect(coordinator.begin('undo')).resolves.toEqual({
            kind: 'refused',
            reason: 'unavailable',
        });
    });

});

describe('the focus region', () => {
    it('spans the cells of the first worksheet the replay touches', () => {
        const { coordinator, posted } = harness([
            cell_change(2, 3, 'a'),
            cell_change(5, 1, 'b'),
        ], 'redo');
        void coordinator.begin('redo');
        const { focus } = last_prepare(posted);
        expect(focus.sourceRowStart).toBe(2);
        expect(focus.sourceRowEnd).toBe(5);
        expect(focus.sourceColumnStart).toBe(1);
        expect(focus.sourceColumnEnd).toBe(3);
    });

    it('ignores cells on other sheets, which no single rectangle could cover', () => {
        const { coordinator, posted } = harness([
            cell_change(2, 2, 'a'),
            cell_change(9, 9, 'b', OTHER),
        ], 'redo');
        void coordinator.begin('redo');
        const { focus } = last_prepare(posted);
        expect(focus.worksheet.worksheetId).toBe('rId1');
        expect(focus.sourceRowEnd).toBe(2);
    });
});

describe('highlight inputs', () => {
    it('expects the side the direction is moving away from', () => {
        const { coordinator, posted } = harness([
            cell_change(0, 0, 'typed'),
            highlight_change(1, 1, null, 'yellow'),
        ]);
        void coordinator.begin('undo');
        const request = last_prepare(posted);
        // Undo restores `before`, so it must find `after` in the cell now.
        expect(request.highlights[0]?.expected).toBe('yellow');
        expect(request.highlights[0]?.desired).toBeNull();
    });

    it('swaps both sides for a redo', () => {
        const { coordinator, posted } = harness([
            cell_change(0, 0, 'typed'),
            highlight_change(1, 1, null, 'yellow'),
        ], 'redo');
        void coordinator.begin('redo');
        const request = last_prepare(posted);
        expect(request.highlights[0]?.expected).toBeNull();
        expect(request.highlights[0]?.desired).toBe('yellow');
    });
});

describe('receiving a prepared response', () => {
    it('posts a commit naming every prepared cell', () => {
        const { coordinator, posted } = harness([
            cell_change(0, 0, 'a'),
            cell_change(1, 0, 'b'),
        ]);
        void coordinator.begin('undo');
        coordinator.on_prepared(prepared_for(last_prepare(posted)));
        const commit = last_commit(posted);
        // Exactly the prepared set: the host refuses a partial proposal, since it
        // is a different gesture from the one the lease authorizes.
        expect(commit.cells.map((cell) => cell.ordinal)).toEqual([0, 1]);
        expect(commit.leaseId).toBe('lease-1');
    });

    it('sends a highlight write per prepared highlight, by ordinal only', () => {
        const { coordinator, posted } = harness([
            cell_change(0, 0, 'typed'),
            highlight_change(1, 1, null, 'yellow'),
            highlight_change(2, 2, 'green', null),
        ]);
        void coordinator.begin('undo');
        coordinator.on_prepared(prepared_for(last_prepare(posted)));
        const commit = last_commit(posted);
        expect(commit.highlights).toEqual([{ ordinal: 0 }, { ordinal: 1 }]);
    });

    it('undoes a typed cell by removing its entry', () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        void coordinator.begin('undo');
        coordinator.on_prepared(prepared_for(last_prepare(posted)));
        // The recorded before-side was absent, so undo removes the overlay.
        expect(last_commit(posted).cells[0]?.entry).toBeNull();
    });

    it('abandons the lease and refuses when the store moved during the round trip', async () => {
        const { coordinator, posted, overlays } = harness([cell_change(0, 0, 'typed')]);
        const outcome = coordinator.begin('undo');
        const request = last_prepare(posted);
        // A keystroke lands while the prepare was in flight.
        overlays.set('0:0', value_only_overlay(history_value('newer'), history_value('base')));
        coordinator.on_prepared(prepared_for(request));
        await expect(outcome).resolves.toEqual({ kind: 'refused', reason: 'conflict' });
        expect(posted.some((entry) => entry.type === 'abandonHistoryReplay')).toBe(true);
    });

    it('ignores a response for a replay it is not running', () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        void coordinator.begin('undo');
        const stale = { ...prepared_for(last_prepare(posted)), replayId: 'someone-else' };
        coordinator.on_prepared(stale);
        expect(posted.some((entry) => entry.type === 'commitHistoryReplay')).toBe(false);
    });

    it('ignores a duplicate prepared response', () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        void coordinator.begin('undo');
        const prepared = prepared_for(last_prepare(posted));
        coordinator.on_prepared(prepared);
        coordinator.on_prepared(prepared);
        expect(posted.filter((entry) => entry.type === 'commitHistoryReplay')).toHaveLength(1);
    });
});

describe('settling', () => {
    async function committed_outcome(): Promise<{
        readonly outcome: ReplayOutcome;
        readonly posted: readonly Posted[];
        readonly accepted: AcceptedReplay | undefined;
    }> {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        const pending = coordinator.begin('undo');
        coordinator.on_prepared(prepared_for(last_prepare(posted)));
        const commit = last_commit(posted);
        const accepted = coordinator.on_committed({
            requestId: commit.requestId,
            replayId: commit.replayId,
            leaseId: commit.leaseId,
            mutationId: commit.mutationId,
            sourceGeneration: 7,
            cells: commit.cells.map((cell) => ({
                ordinal: cell.ordinal,
                resolvedSheetIndex: 0,
                key: '0:0',
                entry: cell.entry,
            })),
            focusSheetIndex: 0,
            focus: last_prepare(posted).focus,
        });
        return { outcome: await pending, posted, accepted };
    }

    it('hands back the entry it accepted, for the caller transaction', async () => {
        const { accepted } = await committed_outcome();
        expect(accepted?.direction).toBe('undo');
        expect(accepted?.entry.action.changes).toHaveLength(1);
        expect(accepted?.committed.sourceGeneration).toBe(7);
    });

    it('resolves with the committed answer and the plan that produced it', async () => {
        const { outcome } = await committed_outcome();
        expect(outcome.kind).toBe('committed');
        if (outcome.kind !== 'committed') return;
        expect(outcome.committed.sourceGeneration).toBe(7);
        expect(outcome.plan.direction).toBe('undo');
    });

    it('frees the reservation once settled, so the next gesture is admitted', async () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        const pending = coordinator.begin('undo');
        const request = last_prepare(posted);
        coordinator.on_prepare_refused({
            requestId: request.requestId,
            replayId: request.replayId,
            reason: 'conflict',
        });
        await pending;
        expect(coordinator.is_busy()).toBe(false);
    });

    it('translates a prepare refusal into the caller vocabulary', async () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        const pending = coordinator.begin('undo');
        const request = last_prepare(posted);
        coordinator.on_prepare_refused({
            requestId: request.requestId,
            replayId: request.replayId,
            reason: 'edit-session-unavailable',
        });
        await expect(pending).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
        expect(coordinator.is_busy()).toBe(false);
    });

    it('reads a moved document as the state it planned against being gone', async () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        const pending = coordinator.begin('undo');
        const request = last_prepare(posted);
        coordinator.on_prepare_refused({
            requestId: request.requestId,
            replayId: request.replayId,
            reason: 'document-changed',
        });
        await expect(pending).resolves.toEqual({ kind: 'refused', reason: 'document-changed' });
    });

    it('translates a commit conflict, leaving history where it was', async () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        const pending = coordinator.begin('undo');
        coordinator.on_prepared(prepared_for(last_prepare(posted)));
        const commit = last_commit(posted);
        coordinator.on_commit_refused({
            requestId: commit.requestId,
            replayId: commit.replayId,
            leaseId: commit.leaseId,
            mutationId: commit.mutationId,
            reason: 'conflict',
        });
        await expect(pending).resolves.toEqual({ kind: 'refused', reason: 'conflict' });
    });

    it('ignores a commit answer for a different mutation', () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        void coordinator.begin('undo');
        coordinator.on_prepared(prepared_for(last_prepare(posted)));
        const commit = last_commit(posted);
        coordinator.on_commit_refused({
            requestId: commit.requestId,
            replayId: commit.replayId,
            leaseId: commit.leaseId,
            mutationId: 'someone-elses-mutation',
            reason: 'conflict',
        });
        expect(coordinator.is_busy()).toBe(true);
    });
});

describe('reset', () => {
    it('settles a running replay rather than leaving its caller waiting', async () => {
        const { coordinator } = harness([cell_change(0, 0, 'typed')]);
        const pending = coordinator.begin('undo');
        coordinator.reset();
        await expect(pending).resolves.toEqual({
            kind: 'refused',
            reason: 'document-changed',
        });
        expect(coordinator.is_busy()).toBe(false);
    });

    it('does not abandon a lease whose commit is already in flight', () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        void coordinator.begin('undo');
        coordinator.on_prepared(prepared_for(last_prepare(posted)));
        const before = posted.filter((entry) => entry.type === 'abandonHistoryReplay').length;
        coordinator.reset();
        // Abandonment races the commit, and losing that race must not cancel a
        // mutation that is already running.
        expect(posted.filter((entry) => entry.type === 'abandonHistoryReplay')).toHaveLength(before);
    });

    it('is harmless when nothing is running', () => {
        const { coordinator, posted } = harness([cell_change(0, 0, 'typed')]);
        coordinator.reset();
        expect(posted).toEqual([]);
    });
});
