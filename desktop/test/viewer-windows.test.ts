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
} from '../main/viewer-windows';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
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
            () => true,
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
            () => true,
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
            () => true,
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
});
