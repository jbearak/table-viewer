import { describe, expect, it, vi } from 'vitest';
import {
    create_app_update_coordinator,
    type AppUpdateDialogs,
    type AppUpdateEngine,
    type AppUpdatePolicy,
    type UpdateInfo,
} from '../main/app-updates';
import type { AppUpdateFailure } from '../main/app-update-failure';
import type { AppUpdatePromptChoice } from '../main/app-update-window';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function fixture(policy: AppUpdatePolicy = { install_updates: true }) {
    const listeners = {} as {
        available: (info: UpdateInfo) => void;
        unavailable: () => void;
        downloaded: (info: UpdateInfo) => void;
        progress: (progress: {
            percent: number;
            transferred: number;
            total: number;
            bytesPerSecond?: number;
        }) => void;
        error: (error: unknown) => void;
    };
    const engine: AppUpdateEngine = {
        check_for_updates: vi.fn(() => new Promise<void>(() => {})),
        download_update: vi.fn(() => new Promise<void>(() => {})),
        quit_and_install: vi.fn(),
        is_online: vi.fn(() => true),
        on_update_available: (listener) => { listeners.available = listener; },
        on_update_not_available: (listener) => { listeners.unavailable = listener; },
        on_update_downloaded: (listener) => { listeners.downloaded = listener; },
        on_download_progress: (listener) => { listeners.progress = listener; },
        on_error: (listener) => { listeners.error = listener; },
    };
    const dialogs: AppUpdateDialogs = {
        offer_download: vi.fn(async (): Promise<AppUpdatePromptChoice> => 'dismiss'),
        show_downloading: vi.fn(),
        update_download_progress: vi.fn(),
        offer_restart: vi.fn(async (): Promise<AppUpdatePromptChoice> => 'dismiss'),
        show_update_available: vi.fn(),
        show_up_to_date: vi.fn(async () => {}),
        show_failure: vi.fn(async (_failure: AppUpdateFailure) => {}),
        show_download_in_progress: vi.fn(),
        dismiss: vi.fn(),
    };
    const request_quit = vi.fn();
    const updates = create_app_update_coordinator(engine, dialogs, request_quit, policy);
    return { dialogs, engine, listeners, request_quit, updates };
}

describe('desktop app updates', () => {
    it('keeps a dismissed version silent on automatic checks but offers a newer one', () => {
        let dismissed = '2.0.0';
        const value = fixture({
            install_updates: true,
            dismissed_version: () => dismissed,
            dismiss_version: (version) => { dismissed = version; },
        });
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        expect(value.dialogs.offer_download).not.toHaveBeenCalled();

        value.updates.check_automatically();
        value.listeners.available({ version: '2.1.0' });
        expect(value.dialogs.offer_download).toHaveBeenCalledWith('2.1.0', true, false);
    });

    it('keeps older feed versions silent after a newer version was dismissed', () => {
        const value = fixture({
            install_updates: true,
            dismissed_version: () => '2.1.0',
        });
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        expect(value.dialogs.offer_download).not.toHaveBeenCalled();
    });

    it('offers a dismissed version when the user explicitly checks', () => {
        const value = fixture({
            install_updates: true,
            dismissed_version: () => '2.0.0',
        });
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        expect(value.dialogs.offer_download).toHaveBeenCalledWith('2.0.0', true, true);
    });

    it('does not lower the dismissal high-water mark after a manual check', async () => {
        let dismissed = '2.1.0';
        const value = fixture({
            install_updates: true,
            dismissed_version: () => dismissed,
            dismiss_version: (version) => { dismissed = version; },
        });
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.dialogs.offer_download).toHaveBeenCalledOnce());
        await Promise.resolve();
        expect(dismissed).toBe('2.1.0');
    });

    it('persists an explicit dismissal but not an app-driven window close', async () => {
        const dismiss_version = vi.fn();
        const dismissed = fixture({ install_updates: true, dismiss_version });
        dismissed.updates.check_automatically();
        dismissed.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(dismiss_version).toHaveBeenCalledWith('2.0.0'));

        const closed = fixture({ install_updates: true, dismiss_version });
        vi.mocked(closed.dialogs.offer_download).mockResolvedValue('closed');
        closed.updates.check_automatically();
        closed.listeners.available({ version: '2.1.0' });
        await vi.waitFor(() => expect(closed.dialogs.offer_download).toHaveBeenCalledOnce());
        await Promise.resolve();
        expect(dismiss_version).toHaveBeenCalledTimes(1);
    });

    it('keeps automatic no-update and error outcomes silent', () => {
        const first = fixture();
        first.updates.check_automatically();
        first.listeners.unavailable();
        expect(first.dialogs.show_up_to_date).not.toHaveBeenCalled();

        for (const error of [
            { code: 'ERR_INTERNET_DISCONNECTED' },
            { statusCode: 503 },
            { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
            new Error('unknown'),
        ]) {
            const value = fixture();
            value.updates.check_automatically();
            value.listeners.error(error);
            expect(value.dialogs.show_failure).not.toHaveBeenCalled();
        }
    });

    it('reports manual no-update and classified error outcomes', () => {
        const first = fixture();
        first.updates.check_manually();
        first.listeners.unavailable();
        expect(first.dialogs.show_up_to_date).toHaveBeenCalledOnce();

        const second = fixture();
        second.updates.check_manually();
        second.listeners.error({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
        expect(second.dialogs.show_failure).toHaveBeenCalledWith({
            phase: 'check',
            kind: 'release-metadata-missing',
        });
    });

    it('uses the online-status port to distinguish a local outage', () => {
        const value = fixture();
        vi.mocked(value.engine.is_online).mockReturnValue(false);
        value.updates.check_manually();
        value.listeners.error(new Error('Request failed'));
        expect(value.dialogs.show_failure).toHaveBeenCalledWith({
            phase: 'check',
            kind: 'internet-unavailable',
        });
    });

    it('still reports a failure when the online-status port throws', () => {
        const value = fixture();
        vi.mocked(value.engine.is_online).mockImplementation(() => {
            throw new Error('network status unavailable');
        });
        value.updates.check_manually();
        value.listeners.error({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
        expect(value.dialogs.show_failure).toHaveBeenCalledWith({
            phase: 'check',
            kind: 'release-metadata-missing',
        });
    });

    it('contains a rejected failure dialog and allows another check', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.show_failure).mockRejectedValueOnce(new Error('dialog failed'));
        value.updates.check_manually();
        value.listeners.error(new Error('Request failed'));
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledOnce());
        value.updates.check_manually();
        expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2);
    });

    it('contains rejected informational dialogs', async () => {
        const current = fixture();
        vi.mocked(current.dialogs.show_up_to_date).mockRejectedValueOnce(new Error('dialog failed'));
        current.updates.check_manually();
        current.listeners.unavailable();
        await vi.waitFor(() => expect(current.dialogs.show_up_to_date).toHaveBeenCalledOnce());

        const downloading = fixture();
        vi.mocked(downloading.dialogs.offer_download).mockResolvedValue('accept');
        vi.mocked(downloading.dialogs.show_download_in_progress)
            .mockImplementationOnce(() => { throw new Error('dialog failed'); });
        downloading.updates.check_manually();
        downloading.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(downloading.engine.download_update).toHaveBeenCalledOnce());
        downloading.updates.check_manually();
        await vi.waitFor(() => {
            expect(downloading.dialogs.show_download_in_progress).toHaveBeenCalledOnce();
        });
    });

    it('upgrades an in-flight automatic check when the user checks manually', () => {
        const value = fixture();
        value.updates.check_automatically();
        value.updates.check_manually();
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
        value.listeners.unavailable();
        expect(value.dialogs.show_up_to_date).toHaveBeenCalledOnce();
    });

    it('reveals a pending automatic offer when the user checks manually', () => {
        const value = fixture();
        const offer = deferred<AppUpdatePromptChoice>();
        vi.mocked(value.dialogs.offer_download).mockReturnValue(offer.promise);
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        value.updates.check_manually();
        expect(value.dialogs.show_update_available).toHaveBeenCalledOnce();
        expect(value.dialogs.show_download_in_progress).not.toHaveBeenCalled();
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
    });

    it('reports that a download is already in progress without relabeling a later failure', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.updates.check_manually();
        expect(value.dialogs.show_download_in_progress).toHaveBeenCalledOnce();
        value.listeners.error(new Error('download failed'));
        expect(value.dialogs.show_failure).not.toHaveBeenCalled();
    });

    it('reports an available update without downloading in check-only builds', async () => {
        const value = fixture();
        const updates = create_app_update_coordinator(
            value.engine,
            value.dialogs,
            value.request_quit,
            { install_updates: false },
        );
        updates.check_manually();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        value.listeners.available({ version: '2.0.0' });
        expect(value.dialogs.offer_download).toHaveBeenCalledWith('2.0.0', false, true);
        updates.check_manually();
        expect(value.dialogs.show_download_in_progress).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(value.dialogs.offer_download).toHaveBeenCalledOnce());
        await Promise.resolve();
        expect(value.engine.download_update).not.toHaveBeenCalled();
        expect(value.engine.quit_and_install).not.toHaveBeenCalled();
        expect(value.request_quit).not.toHaveBeenCalled();
    });

    it('reports a manually initiated download failure as a download', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        expect(value.dialogs.offer_download).toHaveBeenCalledWith('2.0.0', true, true);
        value.listeners.error({ code: 'ERR_UPDATER_ASSET_NOT_FOUND' });
        expect(value.dialogs.show_failure).toHaveBeenCalledWith({
            phase: 'download',
            kind: 'release-artifact-missing',
        });
    });

    it('handles a resolved check when no terminal event is emitted', async () => {
        const value = fixture();
        vi.mocked(value.engine.check_for_updates).mockResolvedValueOnce();
        value.updates.check_manually();
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledWith({
            phase: 'check',
            kind: 'unknown',
        }));
        value.updates.check_manually();
        expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2);
    });

    it('handles a rejected check even when no error event is emitted', async () => {
        const value = fixture();
        const check = deferred<void>();
        vi.mocked(value.engine.check_for_updates).mockReturnValueOnce(check.promise);
        value.updates.check_manually();
        check.reject({ statusCode: 503 });
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledWith({
            phase: 'check',
            kind: 'update-service-unavailable',
        }));
    });

    it('handles a rejected download even when no error event is emitted', async () => {
        const value = fixture();
        const download = deferred<void>();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        vi.mocked(value.engine.download_update).mockReturnValueOnce(download.promise);
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        download.reject({ code: 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' });
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledWith({
            phase: 'download',
            kind: 'release-information-invalid',
        }));
    });

    it('shows one failure when the updater emits and rejects the same error', async () => {
        const value = fixture();
        const check = deferred<void>();
        const error = new Error('net::ERR_INTERNET_DISCONNECTED');
        vi.mocked(value.engine.check_for_updates).mockReturnValueOnce(check.promise);
        value.updates.check_manually();
        value.listeners.error(error);
        check.reject(error);
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledOnce());
    });

    it('reports a reused error object again for a later manual operation', async () => {
        const value = fixture();
        const manual_check = deferred<void>();
        const error = new Error('missing updater configuration');
        vi.mocked(value.engine.check_for_updates)
            .mockReturnValueOnce(new Promise<void>(() => {}))
            .mockReturnValueOnce(manual_check.promise);
        value.updates.check_automatically();
        value.listeners.error(error);
        value.updates.check_manually();
        value.listeners.error(error);
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledOnce());
        manual_check.reject(error);
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledOnce());
    });

    it('ignores a stale duplicate rejection after a newer check begins', async () => {
        const value = fixture();
        const old_check = deferred<void>();
        const error = new Error('old failure');
        vi.mocked(value.engine.check_for_updates).mockReturnValueOnce(old_check.promise);
        value.updates.check_manually();
        value.listeners.error(error);
        value.updates.check_manually();
        old_check.reject(error);
        await vi.waitFor(() => expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2));
        value.listeners.unavailable();
        expect(value.dialogs.show_failure).toHaveBeenCalledOnce();
        expect(value.dialogs.show_up_to_date).toHaveBeenCalledOnce();
    });

    it('treats a reused error event as belonging to the active operation', async () => {
        const value = fixture();
        const old_check = deferred<void>();
        const error = new Error('old failure');
        vi.mocked(value.engine.check_for_updates).mockReturnValueOnce(old_check.promise);
        value.updates.check_manually();
        old_check.reject(error);
        await vi.waitFor(() => expect(value.dialogs.show_failure).toHaveBeenCalledOnce());
        value.updates.check_manually();
        value.listeners.error(error);
        expect(value.dialogs.show_failure).toHaveBeenCalledTimes(2);
    });

    it('recovers when an update dialog cannot be shown', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockRejectedValueOnce(new Error('dialog failed'));
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => {
            value.updates.check_manually();
            expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2);
        });
    });

    it('recovers when an updater error invalidates a pending download dialog', async () => {
        const value = fixture();
        const offer = deferred<AppUpdatePromptChoice>();
        vi.mocked(value.dialogs.offer_download).mockReturnValueOnce(offer.promise);
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        value.listeners.error(new Error('update failed'));
        expect(value.dialogs.show_failure).toHaveBeenCalledOnce();
        offer.reject(new Error('dialog closed'));
        await vi.waitFor(() => {
            value.updates.check_manually();
            expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2);
        });
    });

    it('ignores a stale download answer after a newer manual check starts', async () => {
        const value = fixture();
        const old_offer = deferred<AppUpdatePromptChoice>();
        vi.mocked(value.dialogs.offer_download).mockReturnValueOnce(old_offer.promise);
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        value.listeners.error(new Error('update failed'));
        value.updates.check_manually();
        old_offer.resolve('dismiss');
        await vi.waitFor(() => expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2));
        value.listeners.unavailable();
        expect(value.dialogs.show_up_to_date).toHaveBeenCalledOnce();
    });

    it('downloads only after consent and requests a normal quit after restart consent', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        vi.mocked(value.dialogs.offer_restart).mockResolvedValue('accept');
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        expect(value.dialogs.show_downloading).toHaveBeenCalledWith('2.0.0');
        value.listeners.progress({ percent: 25, transferred: 25, total: 100 });
        expect(value.dialogs.update_download_progress).toHaveBeenCalledWith({
            percent: 25, transferred: 25, total: 100,
        });
        value.listeners.downloaded({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.request_quit).toHaveBeenCalledOnce());
        expect(value.engine.quit_and_install).not.toHaveBeenCalled();
        expect(value.updates.install_if_requested()).toBe('started');
        expect(value.engine.quit_and_install).toHaveBeenCalledOnce();
        expect(value.updates.install_if_requested()).toBe('not-requested');
    });

    it('keeps a failed installation request available for retry', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        vi.mocked(value.dialogs.offer_restart).mockResolvedValue('accept');
        vi.mocked(value.engine.quit_and_install)
            .mockImplementationOnce(() => { throw new Error('installer unavailable'); });
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.listeners.downloaded({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.request_quit).toHaveBeenCalledOnce());
        expect(value.updates.install_if_requested()).toBe('failed');
        expect(value.updates.install_if_requested()).toBe('started');
        expect(value.engine.quit_and_install).toHaveBeenCalledTimes(2);
        expect(value.updates.install_if_requested()).toBe('not-requested');
    });

    it('disarms installation when a requested quit is canceled', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        vi.mocked(value.dialogs.offer_restart).mockResolvedValue('accept');
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.listeners.downloaded({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.request_quit).toHaveBeenCalledOnce());

        value.updates.cancel_install_request();

        expect(value.updates.install_if_requested()).toBe('not-requested');
        expect(value.engine.quit_and_install).not.toHaveBeenCalled();
    });

    it('keeps an approved install armed when shutdown closes a re-opened prompt', async () => {
        const value = fixture();
        const reopened = deferred<AppUpdatePromptChoice>();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        vi.mocked(value.dialogs.offer_restart)
            .mockResolvedValueOnce('accept')
            .mockReturnValueOnce(reopened.promise);
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.listeners.downloaded({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.request_quit).toHaveBeenCalledOnce());
        value.updates.check_manually();
        expect(value.dialogs.offer_restart).toHaveBeenCalledTimes(2);
        value.updates.begin_shutdown();
        reopened.resolve('closed');
        await reopened.promise;

        expect(value.updates.install_if_requested()).toBe('started');
    });

    it('allows checks again after shutdown is canceled', () => {
        const value = fixture();
        value.updates.begin_shutdown();
        value.updates.check_manually();
        expect(value.engine.check_for_updates).not.toHaveBeenCalled();
        value.updates.cancel_install_request();
        value.updates.check_manually();
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
    });

    it('coalesces manual checks while a restart offer is already open', async () => {
        const value = fixture();
        const restart = deferred<AppUpdatePromptChoice>();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue('accept');
        vi.mocked(value.dialogs.offer_restart).mockReturnValue(restart.promise);
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.listeners.downloaded({ version: '2.0.0' });
        expect(value.dialogs.offer_restart).toHaveBeenCalledOnce();
        value.updates.check_manually();
        expect(value.dialogs.offer_restart).toHaveBeenCalledOnce();
        restart.resolve('dismiss');
        await vi.waitFor(() => {
            value.updates.check_manually();
            expect(value.dialogs.offer_restart).toHaveBeenCalledTimes(2);
        });
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
    });
});
