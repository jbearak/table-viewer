import { describe, expect, it } from 'vitest';
import { FileSettleTracker } from '../file-settle';

function tracker(clock: { now: number }) {
    return new FileSettleTracker({
        quiet_ms: 1_000,
        limit_ms: 30_000,
        min_retry_ms: 50,
        now: () => clock.now,
    });
}

describe('FileSettleTracker', () => {
    it('counts a failure on a file unchanged for longer than the quiet window', () => {
        const clock = { now: 100_000 };
        expect(tracker(clock).after_failure({ size: 10, mtime: 50_000 }))
            .toEqual({ type: 'settled' });
    });

    it('waits out the rest of the quiet window after a recent write', () => {
        const clock = { now: 100_000 };
        const settle = tracker(clock);
        expect(settle.after_failure({ size: 10, mtime: 99_700 }))
            .toEqual({ type: 'unsettled', retry_in_ms: 700 });
        clock.now = 100_700;
        expect(settle.after_failure({ size: 10, mtime: 99_700 }))
            .toEqual({ type: 'settled' });
    });

    it('treats a changed stat as a change even when the mtime is old', () => {
        // `cp -p` and `rsync -t` write old mtimes.
        const clock = { now: 100_000 };
        const settle = tracker(clock);
        expect(settle.after_failure({ size: 10, mtime: 1 })).toEqual({ type: 'settled' });
        clock.now = 100_050;
        expect(settle.after_failure({ size: 20, mtime: 1 }))
            .toEqual({ type: 'unsettled', retry_in_ms: 1_000 });
        clock.now = 101_050;
        expect(settle.after_failure({ size: 20, mtime: 1 })).toEqual({ type: 'settled' });
    });

    it('measures a future mtime from when the stat was first seen', () => {
        // A network drive whose clock runs ahead of this machine's.
        const clock = { now: 100_000 };
        const settle = tracker(clock);
        const sample = { size: 10, mtime: 500_000 };
        expect(settle.after_failure(sample)).toEqual({ type: 'unsettled', retry_in_ms: 1_000 });
        clock.now = 100_400;
        expect(settle.after_failure(sample)).toEqual({ type: 'unsettled', retry_in_ms: 600 });
        clock.now = 101_000;
        expect(settle.after_failure(sample)).toEqual({ type: 'settled' });
    });

    it('counts a failure on an absent file at once, as before', () => {
        const clock = { now: 100_000 };
        expect(tracker(clock).after_failure('absent')).toEqual({ type: 'settled' });
    });

    it('waits for a file that reappears after being absent', () => {
        const clock = { now: 100_000 };
        const settle = tracker(clock);
        settle.after_failure('absent');
        clock.now = 100_050;
        expect(settle.after_failure({ size: 10, mtime: 1 }).type).toBe('unsettled');
    });

    it('counts a failure it cannot judge', () => {
        const clock = { now: 100_000 };
        expect(tracker(clock).after_failure(undefined)).toEqual({ type: 'settled' });
    });

    it('stops waiting for a file that never settles once the limit passes', () => {
        const clock = { now: 100_000 };
        const settle = tracker(clock);
        let size = 0;
        while (clock.now < 130_000) {
            expect(settle.after_failure({ size: ++size, mtime: clock.now }).type)
                .toBe('unsettled');
            clock.now += 1_000;
        }
        expect(settle.after_failure({ size: ++size, mtime: clock.now }))
            .toEqual({ type: 'settled' });
    });

    it('never asks for a retry sooner than the minimum', () => {
        const clock = { now: 100_000 };
        expect(tracker(clock).after_failure({ size: 10, mtime: 99_000 + 990 }))
            .toEqual({ type: 'unsettled', retry_in_ms: 990 });
        expect(tracker(clock).after_failure({ size: 10, mtime: 99_000 + 1 }))
            .toEqual({ type: 'unsettled', retry_in_ms: 50 });
    });
});
