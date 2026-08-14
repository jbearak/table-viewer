import { describe, expect, it, vi } from 'vitest';
import {
    create_app_update_window_presenter,
    open_manual_update_page,
    type AppUpdateWindowHost,
    type AppUpdateWindowState,
} from '../main/app-update-window';

function fixture() {
    const presentations: Array<{ state: AppUpdateWindowState; focus: boolean }> = [];
    const host: AppUpdateWindowHost = {
        present: vi.fn((state, focus) => presentations.push({ state, focus })),
        close: vi.fn(),
    };
    return {
        host,
        presentations,
        presenter: create_app_update_window_presenter(host),
    };
}

describe('application update window', () => {
    it('does not focus an update found by an automatic check', () => {
        const value = fixture();
        void value.presenter.offer_download('2.0.0', true, false);
        expect(value.presentations.at(-1)?.focus).toBe(false);
    });

    it('reveals and focuses a pending automatic offer on request', () => {
        const value = fixture();
        void value.presenter.offer_download('2.0.0', true, false);
        value.presenter.show_update_available();
        expect(value.presentations.at(-1)?.focus).toBe(true);
    });

    it('uses a focused independent window for the available-version decision', async () => {
        const value = fixture();
        const answer = value.presenter.offer_download('2.0.0', true);
        expect(value.presentations).toEqual([{
            state: { kind: 'available', version: '2.0.0', installUpdates: true },
            focus: true,
        }]);
        value.presenter.handle_action('secondary');
        await expect(answer).resolves.toBe('dismiss');
        expect(value.host.close).toHaveBeenCalledOnce();
    });

    it('distinguishes a user dismissal from app shutdown closing the window', async () => {
        const user = fixture();
        const dismissed = user.presenter.offer_download('2.0.0', true);
        user.presenter.handle_window_closed(true);
        await expect(dismissed).resolves.toBe('dismiss');

        const shutdown = fixture();
        const closed = shutdown.presenter.offer_download('2.0.0', true);
        shutdown.presenter.handle_window_closed(false);
        await expect(closed).resolves.toBe('closed');
    });

    it('does not reopen progress after it is closed, but a manual check reveals it', () => {
        const value = fixture();
        value.presenter.show_downloading('2.0.0');
        expect(value.presentations.at(-1)).toEqual({
            state: { kind: 'downloading', version: '2.0.0' },
            focus: false,
        });

        value.presenter.handle_window_closed(true);
        value.presenter.update_download_progress({
            percent: 50, transferred: 50, total: 100,
        });
        expect(value.presentations).toHaveLength(1);

        value.presenter.show_download_in_progress();
        expect(value.presentations.at(-1)).toEqual({
            state: {
                kind: 'downloading',
                version: '2.0.0',
                progress: { percent: 50, transferred: 50, total: 100 },
            },
            focus: true,
        });
    });

    it('shows the ready decision and accepts a restart request', async () => {
        const value = fixture();
        const answer = value.presenter.offer_restart('2.0.0');
        expect(value.presentations.at(-1)).toEqual({
            state: { kind: 'ready', version: '2.0.0' },
            focus: true,
        });
        value.presenter.handle_action('primary');
        await expect(answer).resolves.toBe('accept');
    });

    it('coalesces progress updates at the displayed percentage boundary', () => {
        const value = fixture();
        value.presenter.show_downloading('2.0.0');
        value.presenter.update_download_progress({ percent: 10.1, transferred: 101, total: 1_000 });
        value.presenter.update_download_progress({ percent: 10.4, transferred: 104, total: 1_000 });
        value.presenter.update_download_progress({ percent: 10.9, transferred: 109, total: 1_000 });
        expect(value.presentations).toHaveLength(3);
        expect(value.presenter.state).toMatchObject({
            progress: { percent: 10.9, transferred: 109 },
        });
    });

    it('dismisses a settled manual-download prompt when opening the browser fails', async () => {
        const dismiss = vi.fn();
        await expect(open_manual_update_page(
            async () => { throw new Error('browser unavailable'); },
            dismiss,
        )).rejects.toThrow('browser unavailable');
        expect(dismiss).toHaveBeenCalledOnce();
    });

    it('closes an accepted manual-download prompt without reporting a skip', async () => {
        const dismiss = vi.fn();
        await expect(open_manual_update_page(async () => {}, dismiss)).resolves.toBe('closed');
        expect(dismiss).toHaveBeenCalledOnce();
    });
});
