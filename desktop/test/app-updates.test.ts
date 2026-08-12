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
    const listeners: {
        available?: (info: UpdateInfo) => void;
        unavailable?: () => void;
        downloaded?: (info: UpdateInfo) => void;
        error?: () => void;
    } = {};
    const check = deferred();
    const download = deferred();
    const engine: AppUpdateEngine = {
        check_for_updates: vi.fn(() => check.promise),
        download_update: vi.fn(() => download.promise),
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
    return { check, dialogs, download, engine, listeners, request_quit, updates };
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('desktop app updates', () => {
    it('keeps automatic no-update and error outcomes silent', async () => {
        const first = fixture();
        first.updates.check_automatically();
        first.listeners.unavailable?.();
        await tick();
        expect(first.dialogs.show_up_to_date).not.toHaveBeenCalled();

        const second = fixture();
        second.updates.check_automatically();
        second.listeners.error?.();
        await tick();
        expect(second.dialogs.show_check_error).not.toHaveBeenCalled();
    });

    it('reports manual no-update and error outcomes', async () => {
        const first = fixture();
        first.updates.check_manually();
        first.listeners.unavailable?.();
        await tick();
        expect(first.dialogs.show_up_to_date).toHaveBeenCalledOnce();

        const second = fixture();
        second.updates.check_manually();
        second.listeners.error?.();
        await tick();
        expect(second.dialogs.show_check_error).toHaveBeenCalledOnce();
    });

    it('upgrades an in-flight automatic check when the user checks manually', async () => {
        const value = fixture();
        value.updates.check_automatically();
        value.updates.check_manually();
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
        value.listeners.unavailable?.();
        await tick();
        expect(value.dialogs.show_up_to_date).toHaveBeenCalledOnce();
    });

    it('reports that a download is already in progress without relabeling a later failure', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue(true);
        value.updates.check_automatically();
        value.listeners.available?.({ version: '2.0.0' });
        await tick();
        value.updates.check_manually();
        await tick();
        expect(value.dialogs.show_download_in_progress).toHaveBeenCalledOnce();
        value.listeners.error?.();
        await tick();
        expect(value.dialogs.show_check_error).not.toHaveBeenCalled();
    });

    it('recovers when an update dialog cannot be shown', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockRejectedValueOnce(new Error('dialog failed'));
        value.updates.check_manually();
        value.listeners.available?.({ version: '2.0.0' });
        await tick();
        value.updates.check_manually();
        expect(value.engine.check_for_updates).toHaveBeenCalledTimes(2);
    });

    it('downloads only after consent and requests a normal quit after restart consent', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue(true);
        vi.mocked(value.dialogs.offer_restart).mockResolvedValue(true);
        value.updates.check_manually();
        value.listeners.available?.({ version: '2.0.0' });
        await tick();
        expect(value.engine.download_update).toHaveBeenCalledOnce();
        value.listeners.downloaded?.({ version: '2.0.0' });
        await tick();
        expect(value.request_quit).toHaveBeenCalledOnce();
        expect(value.engine.quit_and_install).not.toHaveBeenCalled();
        expect(value.updates.install_if_requested()).toBe(true);
        expect(value.engine.quit_and_install).toHaveBeenCalledOnce();
        expect(value.updates.install_if_requested()).toBe(false);
    });

    it('offers a downloaded update again on a later manual check', async () => {
        const value = fixture();
        vi.mocked(value.dialogs.offer_download).mockResolvedValue(true);
        value.updates.check_automatically();
        value.listeners.available?.({ version: '2.0.0' });
        await tick();
        value.listeners.downloaded?.({ version: '2.0.0' });
        await tick();
        value.updates.check_manually();
        await tick();
        expect(value.dialogs.offer_restart).toHaveBeenCalledTimes(2);
        expect(value.engine.check_for_updates).toHaveBeenCalledOnce();
    });
});
