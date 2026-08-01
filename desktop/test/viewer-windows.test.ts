import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage, WebviewMessage } from '../../src/types';
import {
    CHANNEL_HOST_MESSAGE,
    CHANNEL_HOST_MESSAGE_RECEIPT,
    CHANNEL_WEBVIEW_MESSAGE,
    type DesktopHostMessageEnvelope,
    type PendingEditAcknowledgementReceipt,
} from '../shared/ipc';

const electron_mock = vi.hoisted(() => {
    class FakeEmitter {
        private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

        on(event: string, listener: (...args: any[]) => void): this {
            const listeners = this.listeners.get(event) ?? new Set();
            listeners.add(listener);
            this.listeners.set(event, listeners);
            return this;
        }

        once(event: string, listener: (...args: any[]) => void): this {
            const wrapper = (...args: any[]) => {
                this.removeListener(event, wrapper);
                listener(...args);
            };
            return this.on(event, wrapper);
        }

        removeListener(event: string, listener: (...args: any[]) => void): this {
            this.listeners.get(event)?.delete(listener);
            return this;
        }

        emit(event: string, ...args: any[]): boolean {
            const listeners = [...(this.listeners.get(event) ?? [])];
            for (const listener of listeners) listener(...args);
            return listeners.length > 0;
        }
    }

    class WebContents extends FakeEmitter {
        destroyed = false;
        readonly sent: Array<{
            channel: string;
            message: HostMessage;
            receipt?: PendingEditAcknowledgementReceipt;
        }> = [];

        isDestroyed() { return this.destroyed; }
        send(channel: string, payload: DesktopHostMessageEnvelope) {
            if (this.destroyed) throw new Error('transport destroyed');
            this.sent.push({
                channel,
                message: payload.message as HostMessage,
                receipt: payload.receipt,
            });
        }
        loadURL = vi.fn(async () => {});
        reload = vi.fn();
        reloadIgnoringCache = vi.fn();
    }

    class BrowserWindow extends FakeEmitter {
        static readonly instances: BrowserWindow[] = [];
        readonly webContents = new WebContents();
        destroyed = false;
        closeCalls = 0;
        bounds = { x: 100, y: 100, width: 900, height: 600 };

        constructor(_options: unknown) {
            super();
            BrowserWindow.instances.push(this);
        }

        close() {
            this.closeCalls += 1;
            let prevented = false;
            this.emit('close', { preventDefault: () => { prevented = true; } });
            if (prevented) return;
            this.destroyed = true;
            this.webContents.destroyed = true;
            this.webContents.emit('destroyed');
            this.emit('closed');
        }

        isDestroyed() { return this.destroyed; }
        isMinimized() { return false; }
        isMaximized() { return false; }
        isFullScreen() { return false; }
        restore() {}
        show() {}
        focus() {}
        setRepresentedFilename(_file: string) {}
        setTitle(_title: string) {}
        setDocumentEdited(_dirty: boolean) {}
        setBackgroundColor(_color: string) {}
        getBounds() { return { ...this.bounds }; }
        getNormalBounds() { return { ...this.bounds }; }
    }

    return {
        BrowserWindow,
        ipcMain: new FakeEmitter(),
        dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
        nativeTheme: { shouldUseDarkColors: false },
        screen: {
            getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
            getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
        },
    };
});

const controller_mock = vi.hoisted(() => ({
    panel: undefined as any,
    profile: undefined as any,
    controller: undefined as any,
    attach_viewer: vi.fn((panel: any, _file: string, _store: any, profile: any) => {
        controller_mock.panel = panel;
        controller_mock.profile = profile;
        return controller_mock.controller;
    }),
    profile_for: vi.fn(() => ({ editing: true })),
}));

vi.mock('electron', () => electron_mock);
vi.mock('../../src/viewer-controller', () => ({
    attach_viewer: controller_mock.attach_viewer,
    profile_for: controller_mock.profile_for,
}));

import {
    create_app_quit_coordinator,
    ViewerWindowManager,
    type AppQuitShutdownPort,
} from '../main/viewer-windows';
import {
    create_desktop_lifecycle,
    create_desktop_state_backend,
    type DesktopDrainOutcome,
} from '../main/desktop-lifecycle';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

/**
 * The quit barrier's shutdown port, with every call recorded in one ordered log.
 *
 * One log rather than four spies because the properties under test are all
 * *orderings*: admission must close before the window fence rather than after
 * it, and it must reopen only on the paths that leave the app running.
 */
function shutdown_port(drain: () => Promise<DesktopDrainOutcome>) {
    const calls: string[] = [];
    const port: AppQuitShutdownPort = {
        begin: vi.fn(() => { calls.push('begin'); }),
        abandon: vi.fn(() => { calls.push('abandon'); }),
        drain: vi.fn(async () => {
            calls.push('drain');
            return drain();
        }),
        report_close_failure: vi.fn(() => { calls.push('report'); }),
    };
    return { ...port, calls };
}

function controlled_deadlines() {
    const scheduled: Array<{ active: boolean; callback: () => void }> = [];
    const schedule = (callback: () => void, _delayMs: number) => {
        const deadline = { active: true, callback };
        scheduled.push(deadline);
        return () => { deadline.active = false; };
    };
    return {
        schedule,
        expire_next() {
            const deadline = scheduled.find((candidate) => candidate.active);
            if (!deadline) throw new Error('missing active deadline');
            deadline.active = false;
            deadline.callback();
        },
    };
}

function manager(deadline_scheduler?: (callback: () => void, delayMs: number) => () => void) {
    const config = {
        settings: () => ({
            theme: 'system',
            lightThemeId: 'light',
            darkThemeId: 'dark',
            newWindowSize: 'match-last',
            windowWidth: 900,
            windowHeight: 600,
        }),
        config_port: () => ({}),
        update: vi.fn(),
    };
    return new ViewerWindowManager(
        {} as any,
        config as any,
        '/viewer-preload.js',
        deadline_scheduler,
    );
}

function latest_window() {
    const windows = electron_mock.BrowserWindow.instances;
    const window = windows.at(-1);
    if (!window) throw new Error('viewer window was not created');
    return window;
}

function emit_webview(window: InstanceType<typeof electron_mock.BrowserWindow>, message: WebviewMessage) {
    electron_mock.ipcMain.emit(CHANNEL_WEBVIEW_MESSAGE, { sender: window.webContents }, message);
}

function acknowledge_last_delivery(window: InstanceType<typeof electron_mock.BrowserWindow>) {
    let receipt: PendingEditAcknowledgementReceipt | undefined;
    for (let index = window.webContents.sent.length - 1; index >= 0; index -= 1) {
        receipt = window.webContents.sent[index].receipt;
        if (receipt) break;
    }
    if (!receipt) throw new Error('missing acknowledgement receipt request');
    electron_mock.ipcMain.emit(
        CHANNEL_HOST_MESSAGE_RECEIPT,
        { sender: window.webContents },
        receipt,
    );
}

beforeEach(() => {
    electron_mock.BrowserWindow.instances.length = 0;
    electron_mock.dialog.showMessageBox.mockClear();
    controller_mock.panel = undefined;
    controller_mock.profile = undefined;
    controller_mock.controller = {
        drain: vi.fn(async () => {}),
        dispose: vi.fn(),
    };
    controller_mock.attach_viewer.mockClear();
    controller_mock.profile_for.mockClear();
});

describe('viewer window close protocol', () => {
    it('keeps the desktop viewer profile view-only', () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/view-only.csv');

        expect(controller_mock.profile).toMatchObject({ editing: false });
    });

    it('deduplicates native closes and orders flush, drains, acknowledgement, then close', async () => {
        const first_drain = deferred();
        const second_drain = deferred();
        const events: string[] = [];
        controller_mock.controller.drain
            .mockImplementationOnce(() => {
                events.push('drain:first');
                return first_drain.promise;
            })
            .mockImplementationOnce(() => {
                events.push('drain:second');
                return second_drain.promise;
            });
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/order.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });

        window.close();
        window.close();

        const flush_requests = window.webContents.sent.filter(
            ({ channel, message }) => channel === CHANNEL_HOST_MESSAGE
                && message.type === 'requestPendingEditsFlush',
        );
        expect(flush_requests).toHaveLength(1);
        expect(window.closeCalls).toBe(2);
        const request = flush_requests[0].message;
        if (request.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');

        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:1',
            highestProducedSequence: 3,
        });
        await vi.waitFor(() => expect(events).toEqual(['drain:first']));
        controller_mock.panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:1',
            sequence: 3,
        });
        acknowledge_last_delivery(window);
        expect(events).toEqual(['drain:first']);

        first_drain.resolve();
        await vi.waitFor(() => expect(events).toEqual(['drain:first', 'drain:second']));
        expect(window.destroyed).toBe(false);

        second_drain.resolve();
        await vi.waitFor(() => expect(window.destroyed).toBe(true));
        expect(window.closeCalls).toBe(3);
        expect(electron_mock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it('closes before renderer readiness without sending a flush request', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/pre-ready.csv');
        const window = latest_window();

        window.close();

        await vi.waitFor(() => expect(window.destroyed).toBe(true));
        expect(window.webContents.sent).toEqual([]);
        expect(controller_mock.controller.drain).toHaveBeenCalledTimes(2);
    });

    it('settles a pending close when a successful reload replaces the renderer', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/reloaded-during-close.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        window.close();

        window.webContents.emit('did-navigate', {}, 'tv-app://viewer-1/index.html', 200, 'OK');

        await vi.waitFor(() => expect(electron_mock.dialog.showMessageBox).toHaveBeenCalledTimes(1));
        expect(window.destroyed).toBe(false);
        expect(controller_mock.controller.drain).not.toHaveBeenCalled();
    });

    it('fences menu reload through flush, drains, and state-backend acknowledgement', async () => {
        const first_drain = deferred();
        const second_drain = deferred();
        controller_mock.controller.drain
            .mockImplementationOnce(() => first_drain.promise)
            .mockImplementationOnce(() => second_drain.promise);
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/reload.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });

        expect(viewer_manager.reload(window as any, false)).toBe(true);
        expect(viewer_manager.reload(window as any, false)).toBe(true);
        const requests = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        );
        expect(requests).toHaveLength(1);
        expect(window.webContents.reload).not.toHaveBeenCalled();
        const request = requests[0].message;
        if (request.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');

        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:reload',
            highestProducedSequence: 4,
        });
        await vi.waitFor(() => expect(controller_mock.controller.drain).toHaveBeenCalledTimes(1));
        controller_mock.panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:reload',
            sequence: 4,
        });
        acknowledge_last_delivery(window);
        first_drain.resolve();
        await vi.waitFor(() => expect(controller_mock.controller.drain).toHaveBeenCalledTimes(2));
        expect(window.webContents.reload).not.toHaveBeenCalled();

        second_drain.resolve();
        await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledTimes(1));
        expect(window.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
        expect(window.destroyed).toBe(false);
    });

    it('allows reload retry after the renderer flush deadline expires', async () => {
        const deadlines = controlled_deadlines();
        const viewer_manager = manager(deadlines.schedule);
        viewer_manager.open_file('/tmp/reload-timeout-retry.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });

        viewer_manager.reload(window as any, false);
        deadlines.expire_next();
        await vi.waitFor(() => expect(electron_mock.dialog.showMessageBox).toHaveBeenCalledOnce());
        expect(window.webContents.reload).not.toHaveBeenCalled();

        viewer_manager.reload(window as any, false);
        const requests = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        );
        expect(requests).toHaveLength(2);
        const request = requests.at(-1)?.message;
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing retry flush');
        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 0,
        });

        await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledOnce());
        expect(window.destroyed).toBe(false);
    });

    it('starts a fresh close fence when native close loses the reload completion race', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/reload-close-completion-race.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        window.webContents.reload.mockImplementation(() => window.close());

        viewer_manager.reload(window as any, false);
        const first_request = window.webContents.sent.find(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        )?.message;
        if (first_request?.type !== 'requestPendingEditsFlush') {
            throw new Error('missing reload flush request');
        }
        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: first_request.requestId,
            highestProducedSequence: 0,
        });

        await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        )).toHaveLength(2));
        expect(window.destroyed).toBe(false);

        const second_request = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        ).at(-1)?.message;
        if (second_request?.type !== 'requestPendingEditsFlush') {
            throw new Error('missing close retry flush request');
        }
        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: second_request.requestId,
            highestProducedSequence: 0,
        });

        await vi.waitFor(() => expect(window.destroyed).toBe(true));
    });

    it('re-fences a later close when another listener vetoes destruction', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/close-veto-retry.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        const veto = (event: { preventDefault(): void }) => event.preventDefault();
        window.on('close', veto);

        window.close();
        let requests = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        );
        const first = requests[0]?.message;
        if (first?.type !== 'requestPendingEditsFlush') throw new Error('missing first flush');
        emit_webview(window, {
            type: 'pendingEditsFlush', requestId: first.requestId, highestProducedSequence: 0,
        });
        await vi.waitFor(() => expect(window.closeCalls).toBe(2));
        expect(window.destroyed).toBe(false);

        window.removeListener('close', veto);
        window.close();
        await vi.waitFor(() => {
            requests = window.webContents.sent.filter(
                ({ message }) => message.type === 'requestPendingEditsFlush',
            );
            expect(requests).toHaveLength(2);
        });
        const second = requests[1]?.message;
        if (second?.type !== 'requestPendingEditsFlush') throw new Error('missing retry flush');
        emit_webview(window, {
            type: 'pendingEditsFlush', requestId: second.requestId, highestProducedSequence: 0,
        });
        await vi.waitFor(() => expect(window.destroyed).toBe(true));
    });

    it('lets close supersede a pending reload without starting another flush', async () => {
        const first_drain = deferred();
        const second_drain = deferred();
        controller_mock.controller.drain
            .mockImplementationOnce(() => first_drain.promise)
            .mockImplementationOnce(() => second_drain.promise);
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/reload-then-close.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });

        viewer_manager.reload(window as any, true);
        window.close();
        window.close();

        const requests = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        );
        expect(requests).toHaveLength(1);
        const request = requests[0].message;
        if (request.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:close-wins',
            highestProducedSequence: 5,
        });
        await vi.waitFor(() => expect(controller_mock.controller.drain).toHaveBeenCalledOnce());
        controller_mock.panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:close-wins',
            sequence: 5,
        });
        acknowledge_last_delivery(window);
        first_drain.resolve();
        await vi.waitFor(() => expect(controller_mock.controller.drain).toHaveBeenCalledTimes(2));
        second_drain.resolve();

        await vi.waitFor(() => expect(window.destroyed).toBe(true));
        expect(window.webContents.reload).not.toHaveBeenCalled();
        expect(window.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
        expect(requests).toHaveLength(1);
    });

    it('allows close retry after the renderer flush deadline expires', async () => {
        const deadlines = controlled_deadlines();
        const viewer_manager = manager(deadlines.schedule);
        viewer_manager.open_file('/tmp/flush-timeout-retry.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });

        window.close();
        deadlines.expire_next();
        await vi.waitFor(() => expect(electron_mock.dialog.showMessageBox).toHaveBeenCalledOnce());
        expect(window.destroyed).toBe(false);

        window.close();
        const requests = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        );
        expect(requests).toHaveLength(2);
        const request = requests.at(-1)?.message;
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing retry flush');
        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 0,
        });

        await vi.waitFor(() => expect(window.destroyed).toBe(true));
    });

    it('allows close retry when an unresponsive renderer becomes responsive', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/unresponsive-retry.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });

        window.close();
        window.emit('unresponsive');
        await vi.waitFor(() => expect(electron_mock.dialog.showMessageBox).toHaveBeenCalledOnce());
        expect(window.destroyed).toBe(false);

        window.emit('responsive');
        window.close();
        await vi.waitFor(() => expect(window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        )).toHaveLength(2));
        const request = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        ).at(-1)?.message;
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing retry flush');
        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 0,
        });

        await vi.waitFor(() => expect(window.destroyed).toBe(true));
    });

    it.each([
        ['failed navigation', (window: InstanceType<typeof electron_mock.BrowserWindow>) => {
            window.webContents.emit(
                'did-fail-load', {}, -2, 'FAILED', 'tv-app://viewer-1/index.html', true,
            );
        }],
        ['renderer termination', (window: InstanceType<typeof electron_mock.BrowserWindow>) => {
            window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
        }],
        ['transport destruction', (window: InstanceType<typeof electron_mock.BrowserWindow>) => {
            window.webContents.emit('destroyed');
        }],
        ['an unresponsive renderer', (window: InstanceType<typeof electron_mock.BrowserWindow>) => {
            window.emit('unresponsive');
        }],
    ])('settles a pending close on %s', async (_name, lose_renderer) => {
        const viewer_manager = manager();
        viewer_manager.open_file(`/tmp/${_name}.csv`);
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        window.close();

        lose_renderer(window);

        await vi.waitFor(() => expect(electron_mock.dialog.showMessageBox).toHaveBeenCalledTimes(1));
        expect(window.destroyed).toBe(false);
        expect(controller_mock.controller.drain).not.toHaveBeenCalled();
    });
});

describe('application quit coordinator', () => {
    it('settles a quit close barrier when a renderer becomes unresponsive', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/unresponsive-during-quit.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });

        const closing = viewer_manager.close_all();
        window.emit('unresponsive');

        await expect(closing).resolves.toBe(false);
        expect(electron_mock.dialog.showMessageBox).toHaveBeenCalledOnce();
        expect(window.destroyed).toBe(false);
    });

    it('resumes a vetoed quit once and admits the resumed before-quit event', async () => {
        const closing = deferred();
        const resume_quit = vi.fn();
        const close_viewers = vi.fn(async () => {
            await closing.promise;
            return true;
        });
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
        );
        const first = { preventDefault: vi.fn() };
        const duplicate = { preventDefault: vi.fn() };

        before_quit(first);
        before_quit(duplicate);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(duplicate.preventDefault).toHaveBeenCalledOnce();
        expect(close_viewers).toHaveBeenCalledOnce();
        expect(resume_quit).not.toHaveBeenCalled();

        closing.resolve();
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());

        const resumed = { preventDefault: vi.fn() };
        before_quit(resumed);
        expect(resumed.preventDefault).not.toHaveBeenCalled();
        expect(close_viewers).toHaveBeenCalledOnce();
    });

    it('consumes a rejected quit fence and leaves quitting retryable', async () => {
        const close_viewers = vi.fn()
            .mockRejectedValueOnce(new Error('close fence failed'))
            .mockResolvedValueOnce(true);
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
        );

        const first = { preventDefault: vi.fn() };
        before_quit(first);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(close_viewers).toHaveBeenCalledOnce());
        expect(resume_quit).not.toHaveBeenCalled();

        await expect(close_viewers.mock.results[0].value).rejects.toThrow('close fence failed');
        const retry = { preventDefault: vi.fn() };
        before_quit(retry);
        expect(retry.preventDefault).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(close_viewers).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
    });

    it('leaves a failed quit fence retryable', async () => {
        const close_viewers = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(close_viewers).toHaveBeenCalledTimes(1));
        expect(resume_quit).not.toHaveBeenCalled();

        await expect(close_viewers.mock.results[0].value).resolves.toBe(false);
        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(close_viewers).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
    });

    // Regression guard for the removed "no viewer windows, quit immediately"
    // fast path: with a real SQLite connection open, a welcome-window-only quit
    // still has to release the connection, writer session, and leases.
    //
    // Wired to a *real* manager with no windows rather than a stub, because that
    // is the property the removed has-windows parameter used to be responsible
    // for: `close_all()` over an empty list resolves true, so the window stage is
    // a no-op that still lets the drain run, and no separate emptiness probe is
    // needed to arrange that.
    it('drains the state backend even with no viewer windows open', async () => {
        const draining = deferred();
        const viewer_manager = manager();
        const resume_quit = vi.fn();
        const shutdown = shutdown_port(async () => {
            await draining.promise;
            return { type: 'closed' };
        });
        const before_quit = create_app_quit_coordinator(
            () => viewer_manager.close_all(),
            resume_quit,
            shutdown,
        );
        expect(viewer_manager.has_windows()).toBe(false);

        const first = { preventDefault: vi.fn() };
        before_quit(first);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(shutdown.drain).toHaveBeenCalledOnce());
        expect(resume_quit).not.toHaveBeenCalled();
        // No window was invented to satisfy the empty close stage.
        expect(electron_mock.BrowserWindow.instances).toHaveLength(0);

        draining.resolve();
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        // Admission closes first and is never taken back on a completed quit.
        expect(shutdown.calls).toEqual(['begin', 'drain']);
        expect(shutdown.report_close_failure).not.toHaveBeenCalled();

        const resumed = { preventDefault: vi.fn() };
        before_quit(resumed);
        expect(resumed.preventDefault).not.toHaveBeenCalled();
        expect(shutdown.drain).toHaveBeenCalledOnce();
        expect(resume_quit).toHaveBeenCalledOnce();
    });

    it('stops admission, then closes viewer windows, then drains the backend', async () => {
        // The whole ordering in one log. `stop:admission` first is the fix for the
        // window-created-during-the-fence hole: `close_all` snapshots its entry
        // list, so a window admitted after `close:start` is never fenced, survives
        // the drain over a closed connection, and then vetoes every later quit.
        const closing = deferred();
        const draining = deferred();
        const calls: string[] = [];
        const close_viewers = vi.fn(async () => {
            calls.push('close:start');
            await closing.promise;
            calls.push('close:done');
            return true;
        });
        const shutdown: AppQuitShutdownPort = {
            begin: vi.fn(() => { calls.push('stop:admission'); }),
            abandon: vi.fn(() => { calls.push('resume:admission'); }),
            drain: vi.fn(async (): Promise<DesktopDrainOutcome> => {
                calls.push('drain:start');
                await draining.promise;
                calls.push('drain:done');
                return { type: 'closed' };
            }),
            report_close_failure: vi.fn(() => { calls.push('report'); }),
        };
        const resume_quit = vi.fn(() => { calls.push('resume'); });
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
            shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        // Synchronous with the event: there is no tick between the before-quit and
        // the refusal for an `open-file` to slip through.
        expect(calls).toEqual(['stop:admission', 'close:start']);
        expect(shutdown.drain).not.toHaveBeenCalled();

        closing.resolve();
        await vi.waitFor(() => expect(shutdown.drain).toHaveBeenCalledOnce());
        expect(calls).toEqual(['stop:admission', 'close:start', 'close:done', 'drain:start']);
        expect(resume_quit).not.toHaveBeenCalled();

        draining.resolve();
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        expect(calls).toEqual([
            'stop:admission', 'close:start', 'close:done', 'drain:start', 'drain:done', 'resume',
        ]);
        expect(shutdown.abandon).not.toHaveBeenCalled();
    });

    it('reports a failed close and quits rather than trapping the app', async () => {
        // A rejected close is terminal, not retryable: `OpenedSqliteFileStateStore`
        // memoizes its close promise, so a second attempt returns the same settled
        // rejection without touching the connection. Blocking the quit therefore
        // bought nothing and cost everything — every later Cmd-Q re-entered a
        // barrier that could only fail identically, over an already-closed
        // connection, leaving force-quit as the only exit.
        const close_viewers = vi.fn(async () => true);
        const shutdown = shutdown_port(async () => ({ type: 'close-failed' }));
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
            shutdown,
        );

        const first = { preventDefault: vi.fn() };
        before_quit(first);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        // Visible rather than silent: the connection state is whatever the failed
        // close left it, and the user is told, but the app is quittable.
        expect(shutdown.report_close_failure).toHaveBeenCalledOnce();
        expect(shutdown.calls).toEqual(['begin', 'drain', 'report']);

        // And the resumed quit is admitted, which is the property the old
        // never-latched `allow_quit` destroyed.
        const resumed = { preventDefault: vi.fn() };
        before_quit(resumed);
        expect(resumed.preventDefault).not.toHaveBeenCalled();
        expect(shutdown.drain).toHaveBeenCalledOnce();
    });

    it('restores admission and stays retryable when the close fence rejects', async () => {
        const close_viewers = vi.fn()
            .mockRejectedValueOnce(new Error('close fence failed'))
            .mockResolvedValueOnce(true);
        const shutdown = shutdown_port(async () => ({ type: 'closed' }));
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
            shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(shutdown.abandon).toHaveBeenCalledOnce());
        expect(shutdown.drain).not.toHaveBeenCalled();
        expect(resume_quit).not.toHaveBeenCalled();
        // The app is still up, so it must still open files.
        expect(shutdown.calls).toEqual(['begin', 'abandon']);

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        expect(shutdown.calls).toEqual(['begin', 'abandon', 'begin', 'drain']);
    });

    it('never drains the backend when a viewer vetoes its close, and re-admits', async () => {
        const close_viewers = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const shutdown = shutdown_port(async () => ({ type: 'closed' }));
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
            shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(shutdown.abandon).toHaveBeenCalledOnce());

        // The connection stays open — a window still holds an attached controller
        // — and admission goes back, because refusing to open files in an app the
        // user just chose to keep running is a bug of its own.
        expect(shutdown.drain).not.toHaveBeenCalled();
        expect(resume_quit).not.toHaveBeenCalled();
        expect(shutdown.calls).toEqual(['begin', 'abandon']);

        // Still retryable, and the retry gets its own barrier.
        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        expect(shutdown.calls).toEqual(['begin', 'abandon', 'begin', 'drain']);
    });

    it('shares one barrier, and one admission stop, across concurrent before-quits', async () => {
        const draining = deferred();
        const shutdown = shutdown_port(async () => {
            await draining.promise;
            return { type: 'closed' };
        });
        const close_viewers = vi.fn(async () => true);
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
            shutdown,
        );

        const first = { preventDefault: vi.fn() };
        const duplicate = { preventDefault: vi.fn() };
        before_quit(first);
        before_quit(duplicate);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(duplicate.preventDefault).toHaveBeenCalledOnce();
        expect(close_viewers).toHaveBeenCalledOnce();
        // macOS delivers a second before-quit; both must join the one barrier
        // rather than each closing admission and each racing a drain.
        expect(shutdown.begin).toHaveBeenCalledOnce();

        await vi.waitFor(() => expect(shutdown.drain).toHaveBeenCalledOnce());
        const late = { preventDefault: vi.fn() };
        before_quit(late);
        expect(late.preventDefault).toHaveBeenCalledOnce();
        expect(shutdown.drain).toHaveBeenCalledOnce();
        expect(shutdown.begin).toHaveBeenCalledOnce();

        draining.resolve();
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        expect(shutdown.calls).toEqual(['begin', 'drain']);
        expect(close_viewers).toHaveBeenCalledOnce();
    });

    /** The real backend, wired to a real manager, behind the barrier — the shape
     *  main.ts builds. Only the store is a fake. */
    function real_shutdown(store: { close(): Promise<void> }) {
        const lifecycle = create_desktop_lifecycle();
        const viewer_manager = manager();
        const backend = create_desktop_state_backend(
            lifecycle,
            () => viewer_manager.stop_admission(),
            () => viewer_manager.resume_admission(),
        );
        const reported: number[] = [];
        const shutdown: AppQuitShutdownPort = {
            begin: () => backend.begin_shutdown(),
            abandon: () => backend.abandon_shutdown(),
            drain: () => backend.drain(),
            report_close_failure: () => { reported.push(reported.length + 1); },
        };
        return {
            lifecycle, viewer_manager, backend, shutdown, reported, store,
            publish: () => backend.publish(store),
        };
    }

    it('never leaves the app unquittable when the real store close fails', async () => {
        // Where the defect lived. The underlying close memoizes its rejection
        // (`closePromise ??=` in sqlite-file-state-persistence.ts), so the second
        // drain returned the SAME already-rejected promise without re-attempting
        // anything — the documented "real retry" never retried, `allow_quit` was
        // never latched, and the app could only be force-quit over a connection
        // that had already been released.
        const closes: string[] = [];
        let memoized: Promise<void> | undefined;
        const store = {
            close(): Promise<void> {
                // Memoized exactly as the real store is: one attempt, forever.
                memoized ??= (async () => {
                    closes.push('attempt');
                    throw new Error('close failed');
                })();
                return memoized;
            },
        };
        const wiring = real_shutdown(store);
        await wiring.publish();
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            () => wiring.viewer_manager.close_all(),
            resume_quit,
            wiring.shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        // Attempted once, reported once, and quitting proceeded.
        expect(closes).toEqual(['attempt']);
        expect(wiring.reported).toEqual([1]);

        // The resumed before-quit is admitted, so the app really does exit.
        const resumed = { preventDefault: vi.fn() };
        before_quit(resumed);
        expect(resumed.preventDefault).not.toHaveBeenCalled();
        // And a further drain answers the same terminal outcome without
        // re-awaiting the memoized rejection.
        await expect(wiring.backend.drain()).resolves.toEqual({ type: 'close-failed' });
        expect(closes).toEqual(['attempt']);
    });

    it('refuses a window created during the quit barrier, and re-admits on a veto', async () => {
        // The concrete failure: one viewer open, Cmd-Q, and while its flush/ack
        // fence runs the user double-clicks a CSV in Finder. `close_all` has
        // already snapshotted its entry list, so a window admitted now is never
        // fenced — it survives the drain holding a controller over a closed
        // connection and then vetoes every later quit.
        const store = { close: async (): Promise<void> => {} };
        const wiring = real_shutdown(store);
        await wiring.publish();
        wiring.lifecycle.become_ready();
        wiring.viewer_manager.open_file('/tmp/open-before-quit.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        expect(electron_mock.BrowserWindow.instances).toHaveLength(1);

        // A close that never resolves on its own, so the barrier really is open
        // while the request below arrives — no fixed delay involved.
        const fence = deferred();
        let vetoes = true;
        const close_viewers = vi.fn(async () => {
            await fence.promise;
            return !vetoes;
        });
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            close_viewers,
            resume_quit,
            wiring.shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(close_viewers).toHaveBeenCalledOnce());

        // Mid-fence Finder double-click. Refused at both gates: the class refuses
        // to attach a controller, and the lifecycle phase refuses the request.
        expect(wiring.viewer_manager.open_file('/tmp/during-barrier.csv')).toBeUndefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(1);
        expect(wiring.lifecycle.phase).toBe('draining');
        let submitted = 0;
        wiring.lifecycle.submit(() => { submitted += 1; });
        expect(submitted).toBe(0);

        // The viewer vetoes. The app stays up, so it must open files again — an
        // app that silently ignores every double-click is a bug of its own.
        fence.resolve();
        await vi.waitFor(() => expect(wiring.lifecycle.phase).toBe('ready'));
        expect(resume_quit).not.toHaveBeenCalled();
        expect(wiring.backend.published).toBe(store);
        expect(wiring.backend.draining).toBe(false);
        expect(wiring.viewer_manager.open_file('/tmp/after-veto.csv')).toBeDefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(2);
        wiring.lifecycle.submit(() => { submitted += 1; });
        expect(submitted).toBe(1);

        // And the retry, once nothing vetoes, completes the quit.
        vetoes = false;
        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        expect(wiring.backend.published).toBeUndefined();
    });

    /**
     * The real backend and manager behind the barrier, with every port call in one
     * ordered log and the two post-close statements injectable.
     *
     * Post-close, because that is the whole point: `report_close_failure` is a
     * `console.error` in main.ts and throws on EPIPE, and `resume_quit` is
     * `app.quit()`. Both run *after* the connection has been released, so a throw
     * from either must not be able to reach `abandon` — the store is gone and
     * re-admitting would attach a controller to it.
     */
    /** The store is not a parameter: each caller publishes its own through
     *  `backend.publish`, so taking one here only invited the two to disagree. */
    function post_close_wiring(
        hooks: { on_report?: () => void; on_resume?: () => void } = {},
    ) {
        const lifecycle = create_desktop_lifecycle();
        const viewer_manager = manager();
        const backend = create_desktop_state_backend(
            lifecycle,
            () => viewer_manager.stop_admission(),
            () => viewer_manager.resume_admission(),
        );
        const calls: string[] = [];
        const shutdown: AppQuitShutdownPort = {
            begin: () => { calls.push('begin'); backend.begin_shutdown(); },
            abandon: () => { calls.push('abandon'); backend.abandon_shutdown(); },
            drain: () => { calls.push('drain'); return backend.drain(); },
            report_close_failure: () => {
                calls.push('report');
                hooks.on_report?.();
            },
        };
        const resume_quit = vi.fn(() => {
            calls.push('resume');
            hooks.on_resume?.();
        });
        return { lifecycle, viewer_manager, backend, shutdown, calls, resume_quit };
    }

    /** Rejections that escaped to the process, which in the main process is fatal.
     *  Vitest fails the run on one by itself; this makes the assertion local and
     *  explicit, so the test says what it is protecting. */
    function watch_unhandled_rejections() {
        const escaped: unknown[] = [];
        const listener = (reason: unknown) => { escaped.push(reason); };
        process.on('unhandledRejection', listener);
        return {
            escaped,
            /** Let the microtask queue drain and the rejection be reported, then
             *  stop watching. A turn of the event loop, not a delay. */
            async settle(): Promise<void> {
                await new Promise<void>((done) => { setImmediate(done); });
                await new Promise<void>((done) => { setImmediate(done); });
                process.removeListener('unhandledRejection', listener);
            },
        };
    }

    it('never re-admits when reporting a failed close throws', async () => {
        // `report_close_failure` is a console.error, and console.error throws
        // EPIPE once the parent has closed stdout. The close has already run by
        // then, so this throw must not be routed to `abandon`: doing so would put
        // the lifecycle back to `ready` and let `open_file` attach a controller to
        // a connection nobody can use.
        const rejections = watch_unhandled_rejections();
        const store = { close: async (): Promise<void> => { throw new Error('close failed'); } };
        const wiring = post_close_wiring({
            on_report: () => { throw new Error('EPIPE: stdout is gone'); },
        });
        await wiring.backend.publish(store);
        wiring.lifecycle.become_ready();
        const before_quit = create_app_quit_coordinator(
            () => wiring.viewer_manager.close_all(),
            wiring.resume_quit,
            wiring.shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(wiring.calls).toContain('report'));

        // Reporting is best-effort, so the quit it precedes still happens: a dead
        // stdout must not be what keeps the app on screen over a closed store.
        await vi.waitFor(() => expect(wiring.resume_quit).toHaveBeenCalledOnce());
        expect(wiring.calls).toEqual(['begin', 'drain', 'report', 'resume']);
        // Admission stays shut and the phase stays drained.
        expect(wiring.viewer_manager.open_file('/tmp/after-report-threw.csv')).toBeUndefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(0);
        expect(wiring.lifecycle.phase).toBe('draining');
        expect(wiring.backend.draining).toBe(true);
        let submitted = 0;
        wiring.lifecycle.submit(() => { submitted += 1; });
        expect(submitted).toBe(0);
        // And the quit is not blocking again — a failed close never was.
        const resumed = { preventDefault: vi.fn() };
        before_quit(resumed);
        expect(resumed.preventDefault).not.toHaveBeenCalled();

        await rejections.settle();
        expect(rejections.escaped).toEqual([]);
    });

    it('never re-admits when the resumed quit itself throws', async () => {
        // `resume_quit` is `app.quit()`, called with the connection already closed
        // and cleared. A throw from it used to land in the barrier's trailing
        // catch, which called `abandon`: admission came back, the lifecycle went
        // back to `ready`, and a buffered `open-file` ran immediately — over a
        // store that no longer exists.
        const rejections = watch_unhandled_rejections();
        const closes: string[] = [];
        const store = { close: async (): Promise<void> => { closes.push('close'); } };
        const wiring = post_close_wiring({
            on_resume: () => { throw new Error('app.quit failed'); },
        });
        await wiring.backend.publish(store);
        wiring.lifecycle.become_ready();
        const before_quit = create_app_quit_coordinator(
            () => wiring.viewer_manager.close_all(),
            wiring.resume_quit,
            wiring.shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(wiring.resume_quit).toHaveBeenCalledOnce());

        // The store really is gone, which is why re-admitting would be a bug
        // rather than a nicety.
        expect(closes).toEqual(['close']);
        expect(wiring.backend.published).toBeUndefined();
        expect(wiring.calls).toEqual(['begin', 'drain', 'resume']);
        expect(wiring.viewer_manager.open_file('/tmp/after-resume-threw.csv')).toBeUndefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(0);
        expect(wiring.lifecycle.phase).toBe('draining');
        expect(wiring.backend.draining).toBe(true);
        let submitted = 0;
        wiring.lifecycle.submit(() => { submitted += 1; });
        expect(submitted).toBe(0);

        await rejections.settle();
        expect(rejections.escaped).toEqual([]);
    });

    it('admits no new viewer window once admission has stopped', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/before-drain.csv');
        const window = latest_window();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(1);

        viewer_manager.stop_admission();

        expect(viewer_manager.open_file('/tmp/during-drain.csv')).toBeUndefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(1);
        // Even a file that already has a window is refused while draining.
        expect(viewer_manager.open_file('/tmp/before-drain.csv')).toBeUndefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(1);
        // The windows already open still close through the normal fence.
        expect(viewer_manager.has_windows()).toBe(true);
        emit_webview(window, { type: 'ready' });
        const closing = viewer_manager.close_all();
        const request = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        ).at(-1)?.message;
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 0,
        });

        await expect(closing).resolves.toBe(true);
        expect(viewer_manager.has_windows()).toBe(false);
    });
});
