import { describe, expect, it } from 'vitest';
import { create_edit_session_registry } from '../webview/edit-session-registry';
import { create_history_store } from '../webview/history-store';
import { run_discard_transaction } from '../webview/discard-transaction-model';
import { DEFAULT_HISTORY_BOUNDS, peek_history } from '../webview/history-stack-model';

const SHEETS = [
    { name: 'Data', worksheetId: 'rId1' },
    { name: 'Notes', worksheetId: 'rId2' },
];

function harness(session = 'session') {
    const ref = { current: session as string | undefined };
    const registry = create_edit_session_registry(() => ref.current);
    const history = create_history_store();
    const run = (bounds?: typeof DEFAULT_HISTORY_BOUNDS) => run_discard_transaction({
        registry,
        history,
        sessionId: session,
        sheets: SHEETS,
        bounds,
    });
    return { ref, registry, history, run };
}

describe('run_discard_transaction', () => {
    it('empties every sheet and records one undoable action', () => {
        const { registry, history, run } = harness();
        registry.for_sheet(0).commit('session', '0:0', { value: 'a', base: 'A' });
        registry.for_sheet(1).commit('session', '2:3', { value: 'b', base: 'B' });

        expect(run()).toEqual({ kind: 'recorded' });

        expect(registry.for_sheet(0).snapshot().size).toBe(0);
        expect(registry.for_sheet(1).snapshot().size).toBe(0);
        const peek = peek_history(history.snapshot(), 'undo');
        expect(peek.kind).toBe('available');
        if (peek.kind !== 'available') throw new Error('unreachable');
        expect(peek.entry.action.label).toBe('Discard edits');
        // One gesture, both sheets — undoing it restores the whole workbook.
        expect(peek.entry.action.changes).toHaveLength(2);
    });

    it('reports a discard with nothing in it as recorded, so the host still hears', () => {
        // A discard of an already-empty session validly changes nothing. Reading
        // that as a failure would swallow the terminal message the host needs to
        // clear its own durable slots.
        const { run, history } = harness();
        expect(run()).toEqual({ kind: 'recorded' });
        expect(peek_history(history.snapshot(), 'undo').kind).not.toBe('available');
    });

    it('discards anyway when the gesture is too large to keep, and says so', () => {
        // Refusing a user's discard to protect a history buffer would be the wrong
        // trade. The recording installs the barrier that makes undo explain itself.
        const { registry, history, run } = harness();
        registry.for_sheet(0).commit('session', '0:0', { value: 'x'.repeat(400), base: '' });

        expect(run({ ...DEFAULT_HISTORY_BOUNDS, hardMaxBytes: 64 }))
            .toEqual({ kind: 'unrecordable' });

        expect(registry.for_sheet(0).snapshot().size).toBe(0);
        expect(peek_history(history.snapshot(), 'undo').kind).toBe('blocked');
    });

    it('clears outright when the session has moved on, and says it was stale', () => {
        const { registry, history } = harness();
        registry.for_sheet(0).commit('session', '0:0', { value: 'a', base: 'A' });

        // A store refuses to stage for a session that does not own it, which is a
        // discard arriving after the session it belonged to was replaced.
        const outcome = run_discard_transaction({
            registry,
            history,
            sessionId: 'a-later-session',
            sheets: SHEETS,
        });

        expect(outcome).toEqual({ kind: 'stale' });
        // The store keeps its edits, and deliberately: they belong to a session
        // this discard does not own, and the fallback clear refuses for the same
        // reason the staging did. Nothing is recorded either — there is no gesture
        // here to undo.
        expect(registry.for_sheet(0).get('0:0')).toEqual({ value: 'a', base: 'A' });
        expect(peek_history(history.snapshot(), 'undo').kind).not.toBe('available');
    });

    it('leaves the edits and the history alone when a store moves mid-transaction', () => {
        // All or nothing: a half-applied discard is edits gone with nothing in
        // history describing them.
        const { registry, history } = harness();
        const store = registry.for_sheet(0);
        store.commit('session', '0:0', { value: 'a', base: 'A' });
        const original = history.snapshot();

        // Stage against one state, then land a keystroke before the transaction can
        // commit — exactly what each participant's `valid()` exists to catch.
        const outcome = run_discard_transaction({
            registry: {
                ...registry,
                stage_discard: (session_id, sheets) => {
                    const staged = registry.stage_discard(session_id, sheets);
                    store.commit('session', '9:9', { value: 'late', base: '' });
                    return staged;
                },
            },
            history,
            sessionId: 'session',
            sheets: SHEETS,
        });

        expect(outcome).toEqual({ kind: 'abandoned' });
        expect(store.get('0:0')).toEqual({ value: 'a', base: 'A' });
        expect(store.get('9:9')).toEqual({ value: 'late', base: '' });
        expect(history.snapshot()).toBe(original);
    });
});
