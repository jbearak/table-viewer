import { describe, expect, it } from 'vitest';
import { pending_signal } from '../webview/pending-signal';

describe('pending_signal', () => {
    it('hands the same answer to every awaiter', async () => {
        const signal = pending_signal<boolean>();
        const first = signal.settled;
        const second = signal.settled;
        signal.settle(true);
        expect(await first).toBe(true);
        expect(await second).toBe(true);
    });

    it('serves a caller that arrives after it settled', async () => {
        // The acknowledgement can land before the code that waits on it runs, and
        // a late awaiter must read the answer rather than hang forever.
        const signal = pending_signal<boolean>();
        signal.settle(false);
        expect(await signal.settled).toBe(false);
    });

    it('ignores a second settle, so a duplicate message cannot change the answer', async () => {
        const signal = pending_signal<boolean>();
        signal.settle(true);
        signal.settle(false);
        expect(await signal.settled).toBe(true);
    });
});
