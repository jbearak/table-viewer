import { describe, expect, it, vi } from 'vitest';
import {
    create_app_update_coordinator,
    type AppUpdateDialogs,
    type AppUpdateEngine,
    type UpdateInfo,
} from '../main/app-updates';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function fixture() {
    const listeners = {} as {
        available: (info: UpdateInfo) => void;
        unavailable: () => void;
        downloaded: (info: UpdateInfo) => void;
        error: () => void;
    };
    const engine: AppUpdateEngine = {
        check_for_updates: vi.fn(async () => {}),
        download_update: vi.fn(async () => {}),
        quit_and_install: vi.fn(),
        on_update_available: (listener) => { listeners.available = listener; },
        on_update_not_available: (listener) => { listeners.unavailable = listener; },
        on_update_downloaded: (listener) => { listeners.downloaded = listener; },
        on_error: (listener) => { listeners.error = listener; },
    };
    const dialogs: AppUpdateDialogs = {
        offer_download: vi.fn(async () => false),
        offer_restart: vi.fn(async () => false),
        show_up_to_date: vi.fn(async () => {}),
        show_check_error: vi.fn(async () => {}),
        show_download_in_progress: vi.fn(async () => {}),
    };
    const request_quit = vi.fn();
    const updates = create_app_update_coordinator(engine, dialogs, request_quit);
    return { dialogs, engine, listeners, request_quit, updates };
}

describe('desktop app updates', () => {
    it('keeps automatic no-update and error outcomes silent', () => {
        const first = fixture();
        first.updates.check_automatically();
        first.listeners.unavailable();
        expect(first.dialogs.show_up_to_date).not.toHaveBeenCalled();

        const second = fixture();
        second.updates.check_automatically();
        second.listeners.error();
        expect(second.dialogs.show_check_error).not.toHaveBeenCalled();
    });

    it('reports manual no-update and error outcomes', () => {
        const first = fixture();
        first.updates.check_manually();
        first.listeners.unavailable();
        expect(first.dialogs.show_up_to_date).toHaveBeenCalledOnce();

        const second = fixture();
        second.updates.check_manually();
        second.listeners.error();
        expect(second.dialogs.show_check_error).toHaveBeenCalledOnce();
    });

    it('upgrades an in-flight automatic check when the user checks manually', () => {
        const value = fixture();
        value.updates.check_automatically();
        value.updates.check_manually();
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
        value.listeners.unavailable();
        expect(value.dialogs.show_up_to_date).toHaveBeenCalledOnce();
    });

    it('reports that a download is already in progress without relabeling a later failure', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue(true);
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.updates.check_manually();
        expect(value.dialogs.show_download_in_progress).toHaveBeenCalledOnce();
        value.listeners.error();
        expect(value.dialogs.show_check_error).not.toHaveBeenCalled();
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
        const offer = deferred<boolean>();
        vi.mocked(value.dialogs.offer_download).mockReturnValueOnce(offer.promise);
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        value.listeners.error();
        expect(value.dialogs.show_check_error).toHaveBeenCalledOnce();
        offer.reject(new Error('dialog closed'));
        await vi.waitFor(() => {
            value.updates.check_manually();
            expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2);
        });
    });

    it('ignores a stale download answer after a newer manual check starts', async () => {
        const value = fixture();
        const old_offer = deferred<boolean>();
        vi.mocked(value.dialogs.offer_download).mockReturnValueOnce(old_offer.promise);
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        value.listeners.error();
        value.updates.check_manually();
        old_offer.resolve(false);
        await vi.waitFor(() => expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2));
        value.listeners.unavailable();
        expect(value.dialogs.show_up_to_date).toHaveBeenCalledOnce();
    });

    it('downloads only after consent and requests a normal quit after restart consent', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue(true);
        vi.mocked(value.dialogs.offer_restart).mockResolvedValue(true);
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.listeners.downloaded({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.request_quit).toHaveBeenCalledOnce());
        expect(value.engine.quit_and_install).not.toHaveBeenCalled();
        expect(value.updates.install_if_requested()).toBe(true);
        expect(value.engine.quit_and_install).toHaveBeenCalledOnce();
        expect(value.updates.install_if_requested()).toBe(false);
    });

    it('keeps a failed installation request available for retry', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue(true);
        vi.mocked(value.dialogs.offer_restart).mockResolvedValue(true);
        vi.mocked(value.engine.quit_and_install)
            .mockImplementationOnce(() => { throw new Error('installer unavailable'); });
        value.updates.check_manually();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.listeners.downloaded({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.request_quit).toHaveBeenCalledOnce());
        expect(value.updates.install_if_requested()).toBe(false);
        expect(value.updates.install_if_requested()).toBe(true);
        expect(value.engine.quit_and_install).toHaveBeenCalledTimes(2);
        expect(value.updates.install_if_requested()).toBe(false);
    });

    it('coalesces manual checks while a restart offer is already open', async () => {
        const value = fixture();
        const restart = deferred<boolean>();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue(true);
        vi.mocked(value.dialogs.offer_restart).mockReturnValue(restart.promise);
        value.updates.check_automatically();
        value.listeners.available({ version: '2.0.0' });
        await vi.waitFor(() => expect(value.engine.download_update).toHaveBeenCalledOnce());
        value.listeners.downloaded({ version: '2.0.0' });
        expect(value.dialogs.offer_restart).toHaveBeenCalledOnce();
        value.updates.check_manually();
        expect(value.dialogs.offer_restart).toHaveBeenCalledOnce();
        restart.resolve(false);
        await vi.waitFor(() => {
            value.updates.check_manually();
            expect(value.dialogs.offer_restart).toHaveBeenCalledTimes(2);
        });
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
    });
});
