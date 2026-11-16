import { describe, expect, it } from 'vitest';
import {
    HISTORY_MESSAGE_REPEAT_MS,
    HISTORY_PRESS_HOLD_MS,
    history_message_is_repeat,
    history_press_bound_reached,
    history_press_gate,
    press_admits_ticket,
    view_step_press_gate,
    type HistoryPressFacts,
    type ViewStepPressFacts,
} from '../webview/history-press-model';

const idle: HistoryPressFacts = {
    header_reload_required: false,
    header_change_in_flight: false,
    replay_in_flight: false,
    gesture_in_flight: false,
    view_request_in_flight: false,
    session_gesture_pending: false,
    save_in_flight: false,
};

describe('history_press_gate', () => {
    it('runs a press in a window that is doing nothing', () => {
        expect(history_press_gate(idle)).toEqual({ kind: 'run' });
    });

    it.each([
        ['header_change_in_flight', 'applying'],
        ['replay_in_flight', 'applying'],
        ['gesture_in_flight', 'applying'],
        ['view_request_in_flight', 'updating'],
        ['session_gesture_pending', 'applying'],
        ['save_in_flight', 'saving'],
    ] as const)('holds a press behind %s, as %s', (fact, wait) => {
        expect(history_press_gate({ ...idle, [fact]: true })).toEqual({ kind: 'hold', wait });
    });

    it('says a fence that needs a reload, whatever else is in flight', () => {
        expect(history_press_gate({ ...idle, header_reload_required: true }))
            .toEqual({ kind: 'reload-required' });
        expect(history_press_gate({
            header_reload_required: true,
            header_change_in_flight: true,
            replay_in_flight: true,
            gesture_in_flight: true,
            view_request_in_flight: true,
            session_gesture_pending: true,
            save_in_flight: true,
        })).toEqual({ kind: 'reload-required' });
    });

    it('names the older work: a replay or a gesture before a sort, and a sort before a save', () => {
        expect(history_press_gate({ ...idle, replay_in_flight: true, view_request_in_flight: true }))
            .toEqual({ kind: 'hold', wait: 'applying' });
        expect(history_press_gate({ ...idle, gesture_in_flight: true, view_request_in_flight: true }))
            .toEqual({ kind: 'hold', wait: 'applying' });
        expect(history_press_gate({ ...idle, view_request_in_flight: true, save_in_flight: true }))
            .toEqual({ kind: 'hold', wait: 'updating' });
        expect(history_press_gate({ ...idle, view_request_in_flight: true, session_gesture_pending: true }))
            .toEqual({ kind: 'hold', wait: 'updating' });
        expect(history_press_gate({ ...idle, session_gesture_pending: true, save_in_flight: true }))
            .toEqual({ kind: 'hold', wait: 'applying' });
    });
});

describe('view_step_press_gate', () => {
    const facts = (overrides: Partial<ViewStepPressFacts> = {}): ViewStepPressFacts => ({
        session_id: 'session',
        fenced_session_id: 'session',
        applied_snapshot_seq: 4,
        release_seq: undefined,
        ...overrides,
    });

    it('holds a view step while the session it would run under is on its way out', () => {
        expect(view_step_press_gate(facts())).toEqual({ kind: 'hold', wait: 'finishing' });
    });

    it('does not wait in a window that never had an editing session', () => {
        expect(view_step_press_gate(facts({ session_id: undefined, fenced_session_id: undefined })))
            .toEqual({ kind: 'run' });
    });

    it('does not wait when the session is gone, or another one is held', () => {
        expect(view_step_press_gate(facts({ session_id: undefined }))).toEqual({ kind: 'run' });
        expect(view_step_press_gate(facts({ session_id: 'next' }))).toEqual({ kind: 'run' });
        expect(view_step_press_gate(facts({ fenced_session_id: undefined }))).toEqual({ kind: 'run' });
    });

    it('ends the wait with the next snapshot applied, though the session id has not changed', () => {
        // First held at 4 snapshots applied.
        expect(view_step_press_gate(facts({ release_seq: 4 }))).toEqual({ kind: 'hold', wait: 'finishing' });
        expect(view_step_press_gate(facts({ release_seq: 4, applied_snapshot_seq: 5 }))).toEqual({ kind: 'run' });
    });
});

describe('history_press_bound_reached', () => {
    it('is reached at the bound and not before', () => {
        expect(history_press_bound_reached({ started: 1_000 }, 1_000)).toBe(false);
        expect(history_press_bound_reached({ started: 1_000 }, 1_000 + HISTORY_PRESS_HOLD_MS - 1)).toBe(false);
        expect(history_press_bound_reached({ started: 1_000 }, 1_000 + HISTORY_PRESS_HOLD_MS)).toBe(true);
    });
});

describe('press_admits_ticket', () => {
    it('admits everything when no press waits', () => {
        expect(press_admits_ticket({ held_epoch: undefined, retry_epoch: undefined, ticket: undefined })).toBe(true);
        expect(press_admits_ticket({ held_epoch: undefined, retry_epoch: undefined, ticket: 9 })).toBe(true);
    });

    it('with a press held, admits only what was made before it', () => {
        expect(press_admits_ticket({ held_epoch: 5, retry_epoch: undefined, ticket: undefined })).toBe(false);
        expect(press_admits_ticket({ held_epoch: 5, retry_epoch: undefined, ticket: 4 })).toBe(true);
        expect(press_admits_ticket({ held_epoch: 5, retry_epoch: undefined, ticket: 5 })).toBe(false);
        expect(press_admits_ticket({ held_epoch: 5, retry_epoch: undefined, ticket: 6 })).toBe(false);
    });

    it('with a retry waiting, the same', () => {
        expect(press_admits_ticket({ held_epoch: undefined, retry_epoch: 3, ticket: undefined })).toBe(false);
        expect(press_admits_ticket({ held_epoch: undefined, retry_epoch: 3, ticket: 2 })).toBe(true);
        expect(press_admits_ticket({ held_epoch: undefined, retry_epoch: 3, ticket: 3 })).toBe(false);
    });

    it('with a press held behind a retry, the retry governs', () => {
        const both = { held_epoch: 5, retry_epoch: 3 };
        // Made before both presses.
        expect(press_admits_ticket({ ...both, ticket: 2 })).toBe(true);
        // Made after the retry's press and before the held one.
        expect(press_admits_ticket({ ...both, ticket: 3 })).toBe(false);
        expect(press_admits_ticket({ ...both, ticket: 4 })).toBe(false);
        // Made after both.
        expect(press_admits_ticket({ ...both, ticket: 5 })).toBe(false);
        expect(press_admits_ticket({ ...both, ticket: undefined })).toBe(false);
    });

    it('counts 0 as a ticket: the press\'s own fold', () => {
        expect(press_admits_ticket({ held_epoch: 1, retry_epoch: undefined, ticket: 0 })).toBe(true);
        expect(press_admits_ticket({ held_epoch: 4, retry_epoch: 1, ticket: 0 })).toBe(true);
    });
});

describe('history_message_is_repeat', () => {
    it('is a repeat only for the same sentence within the window', () => {
        const last = { message: 'Cannot undo any further.', at: 10_000 };
        expect(history_message_is_repeat(null, last.message, 10_000)).toBe(false);
        expect(history_message_is_repeat(last, last.message, 10_001)).toBe(true);
        expect(history_message_is_repeat(last, last.message, 10_000 + HISTORY_MESSAGE_REPEAT_MS - 1)).toBe(true);
        expect(history_message_is_repeat(last, last.message, 10_000 + HISTORY_MESSAGE_REPEAT_MS)).toBe(false);
        expect(history_message_is_repeat(last, 'Another sentence.', 10_001)).toBe(false);
    });
});
