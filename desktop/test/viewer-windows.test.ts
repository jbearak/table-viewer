import * as path from 'node:path';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
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
        destroyCalls = 0;
        bounds = { x: 100, y: 100, width: 900, height: 600 };

        constructor(_options: unknown) {
            super();
            BrowserWindow.instances.push(this);
        }

        /**
         * Electron's own close-event contract, including `defaultPrevented`.
         *
         * The flag is not decoration: `close_fenced_window` uses it to tell a
         * veto from a close that is merely still in flight, because on macOS
         * `close()` returns with the window alive and destroys it a tick later.
         * A fake that only offered `preventDefault` let a synchronous-destruction
         * double stand in for that, which is exactly how the real hang — every
         * fenced close reported as a veto, so the app never drained — passed the
         * unit suite while failing the packaged app.
         *
         * `closeAsync` models the platform behaviour directly: the destruction is
         * deferred to a microtask, so any code that reads `isDestroyed()` right
         * after `close()` sees what macOS shows it.
         */
        closeAsync = false;

        /**
         * `close()` throws instead of closing.
         *
         * A real possibility rather than a contrivance: `close` on a window being
         * torn down by the OS can raise, and the fence's own `close` listeners run
         * inside this call, so anything one of them throws surfaces here too.
         */
        closeThrows = false;

        /**
         * The close event dispatches, nobody calls `preventDefault`, and the
         * window is still never destroyed.
         *
         * Chromium's own behaviour when a renderer holds a `beforeunload` handler:
         * the main-process `close` event has already fired, uncancelled, by the
         * time Chromium cancels the close itself. It announces that cancellation
         * on the webContents as `will-prevent-unload`, which is modelled here —
         * that event is the only in-band signal distinguishing this from a close
         * that is merely slow, and until the fence observed it there was nothing
         * left to resolve the promise.
         */
        closeStalls = false;

        /**
         * `close()` destroys the window and *then* throws.
         *
         * The order is what makes this its own case rather than a variant of
         * `closeThrows`: the close genuinely succeeded, so `closed` has already
         * fired and the fence has already settled, and only afterwards does an
         * exception surface. Reachable in the real app because the app's own
         * creation-time `close` listener runs inside `close()` and calls into
         * `close_entry`/`flush_size`, so anything either throws comes back out of
         * this call after the window is gone.
         */
        closeThrowsAfterDestroy = false;

        /**
         * `close()` destroys the window without emitting `closed`.
         *
         * Electron's `closed` is an event, not a guarantee: a window torn down by
         * the OS, or destroyed while the emit path is already unwinding, can leave
         * `isDestroyed()` true with no event ever delivered. It is the one shape in
         * which the window's own state and its event stream disagree, which makes
         * it the only way to test that the fence trusts the former.
         */
        closeDestroysSilently = false;

        destroy() {
            this.destroyCalls += 1;
            if (this.destroyed) return;
            this.destroyed = true;
            this.webContents.destroyed = true;
            this.webContents.emit('destroyed');
            this.emit('closed');
        }

        close() {
            this.closeCalls += 1;
            if (this.closeThrows) throw new Error('close failed');
            if (this.closeDestroysSilently) {
                this.destroyed = true;
                this.webContents.destroyed = true;
                return;
            }
            const event = {
                defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; },
            };
            this.emit('close', event);
            if (event.defaultPrevented) return;
            if (this.closeStalls) {
                // Chromium cancels on the renderer's behalf and says so. The
                // window is not destroyed and no `closed` will ever arrive.
                this.webContents.emit('will-prevent-unload', {
                    defaultPrevented: false,
                    preventDefault() { this.defaultPrevented = true; },
                });
                return;
            }
            const destroy = () => {
                this.destroyed = true;
                this.webContents.destroyed = true;
                this.webContents.emit('destroyed');
                this.emit('closed');
            };
            if (this.closeAsync) queueMicrotask(destroy);
            else destroy();
            if (this.closeThrowsAfterDestroy) throw new Error('teardown listener failed');
        }

        isDestroyed() { return this.destroyed; }
        /** Focus is not modelled otherwise; the menu-rebuild callback reads it. */
        focused = true;
        isFocused() { return this.focused; }
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
    options: undefined as any,
    attach_viewer: vi.fn((
        panel: any,
        _file: string,
        _store: any,
        profile: any,
        _host: any,
        options: any,
    ) => {
        controller_mock.panel = panel;
        controller_mock.profile = profile;
        controller_mock.options = options;
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
    close_desktop_windows,
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

function manager(
    deadline_scheduler?: (callback: () => void, delayMs: number) => () => void,
    on_history_menu_changed?: (window: ElectronBrowserWindow) => void,
) {
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
        undefined,
        on_history_menu_changed,
    );
}

function latest_window() {
    const windows = electron_mock.BrowserWindow.instances;
    const window = windows.at(-1);
    if (!window) throw new Error('viewer window was not created');
    return window;
}

/**
 * The manager's internal record for one open file.
 *
 * Reaches past `private` deliberately and narrowly: `allowClose` is the flag that
 * decides whether a user-initiated close is fenced or tears the window down
 * unfenced (losing unacknowledged `pendingEdits`), and it is not observable from
 * outside — the promise cannot show it, because a second `resolve` on a settled
 * promise is silently ignored, so a broken settle guard looks identical from
 * there. Asserting on it is what makes idempotence testable at all.
 */
function viewer_entry(
    viewer_manager: ViewerWindowManager,
    file_path: string,
): { allowClose: boolean } {
    const entries = (viewer_manager as unknown as {
        windows: Array<{ fileKey: string; allowClose: boolean }>;
    }).windows;
    const basename = path.basename(file_path);
    const entry = entries.find(
        (candidate) => path.basename(candidate.fileKey) === basename,
    );
    if (!entry) throw new Error(`no viewer entry for ${file_path}`);
    return entry;
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
    controller_mock.options = undefined;
    controller_mock.controller = {
        drain: vi.fn(async () => {}),
        dispose: vi.fn(),
    };
    controller_mock.attach_viewer.mockClear();
    controller_mock.profile_for.mockClear();
});

describe('viewer profile wiring', () => {
    it.each([
        ['/tmp/editable.csv', true],
        ['/tmp/editable.tsv', true],
        ['/tmp/read-only.xlsx', false],
    ] as const)('passes the shared profile through unchanged for %s', (file_path, editing) => {
        const profile = { editing, marker: Symbol(file_path) };
        controller_mock.profile_for.mockReturnValueOnce(profile);
        const viewer_manager = manager();

        viewer_manager.open_file(file_path);

        expect(controller_mock.profile_for).toHaveBeenCalledWith(file_path, expect.anything());
        expect(controller_mock.profile).toBe(profile);
    });
});

describe('open viewer paths', () => {
    it('reports only live windows in creation order', () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/first.csv');
        viewer_manager.open_file('/tmp/second.xlsx');
        expect(viewer_manager.open_file_paths()).toEqual([
            '/tmp/first.csv',
            '/tmp/second.xlsx',
        ]);

        electron_mock.BrowserWindow.instances[0].destroyed = true;
        expect(viewer_manager.open_file_paths()).toEqual(['/tmp/second.xlsx']);
    });
});

describe('viewer window close protocol', () => {
    it('finds a viewer entry by exact basename rather than substring', () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/prefix-target.csv');
        viewer_manager.open_file('/tmp/target.csv');
        const entries = (viewer_manager as unknown as {
            windows: Array<{ allowClose: boolean }>;
        }).windows;
        entries[0].allowClose = false;
        entries[1].allowClose = true;

        expect(viewer_entry(viewer_manager, '/tmp/target.csv').allowClose).toBe(true);
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

    // Where the packaged app hung. On macOS `BrowserWindow.close()` returns with
    // the window still alive, so the old `close(); return isDestroyed()` probe
    // read `false` for a close that was proceeding normally, reported it as a
    // veto, and made `close_all` answer false — the quit barrier abandoned, the
    // SQLite connection was never released, its reader token was left behind, and
    // the app could only be force-quit. The synchronous unit-test double hid it
    // completely; `closeAsync` is that platform behaviour, in a test.
    it('treats an asynchronously destroyed window as closed, not vetoed', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/async-close.csv');
        const window = latest_window();
        window.closeAsync = true;
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

        // True, and only once the window really is gone: the drain that follows
        // must not overtake a controller that is still attached.
        await expect(closing).resolves.toBe(true);
        expect(window.destroyed).toBe(true);
        expect(viewer_manager.has_windows()).toBe(false);
        expect(electron_mock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    // The other half: a genuine veto is still a veto when the close is
    // asynchronous. `defaultPrevented` is what tells the two apart, so this is
    // the test that stops the fix above from becoming "always report success".
    it('still reports a veto when an asynchronous close is refused', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/async-close-veto.csv');
        const window = latest_window();
        window.closeAsync = true;
        emit_webview(window, { type: 'ready' });
        window.on('close', (event: { preventDefault(): void }) => event.preventDefault());

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

        await expect(closing).resolves.toBe(false);
        expect(window.destroyed).toBe(false);
        // And the unfenced-close guard is back on, so the next user close starts
        // a fresh fence rather than tearing down without one.
        window.close();
        await vi.waitFor(() => expect(window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        )).toHaveLength(2));
    });

    // The dispatch-order hazard. `close_fenced_window` attaches its own `close`
    // listener immediately before calling `close()`, and an earlier version read
    // `defaultPrevented` from inside that listener — i.e. at *its* point in the
    // dispatch order. A listener sitting after it that vetoes therefore set the
    // flag too late to be seen: the fence concluded "not vetoed", waited for a
    // `closed` event that a vetoed window never emits, and the promise never
    // settled. `close_all` never resolved, the quit barrier never completed, and
    // the app became unquittable — the exact symptom the async-close fix removed,
    // reintroduced through a different door.
    //
    // No listener registered after the observer exists today (the app's own is
    // attached at window creation, so it is always earlier, and during a fence it
    // returns early on `allowClose`). That made the old code correct purely by an
    // ordering invariant nothing stated or enforced — precisely the kind of
    // assumption a later menu handler or lazily-attached listener breaks. This
    // test removes the dependence on it.
    //
    // The late listener is installed by intercepting the one `on('close', …)` the
    // fence itself performs, which is the only moment "after the observer" exists.
    // Dispatch stays plain registration order; nothing about the event model is
    // rigged.
    it('reports a veto from a listener registered after the fence observer', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/late-veto.csv');
        const window = latest_window();
        window.closeAsync = true;
        emit_webview(window, { type: 'ready' });

        const real_on = window.on.bind(window);
        let intercepted = false;
        window.on = ((event: string, listener: (...args: any[]) => void) => {
            const result = real_on(event, listener);
            if (event === 'close' && !intercepted) {
                intercepted = true;
                // Registered last, so it runs after the fence's observer has
                // already sampled the event.
                real_on('close', (close_event: { preventDefault(): void }) => {
                    close_event.preventDefault();
                });
            }
            return result;
        }) as typeof window.on;

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

        // Settles at all — the property that was actually broken — and settles
        // false, because the window is staying open.
        await expect(closing).resolves.toBe(false);
        expect(intercepted).toBe(true);
        expect(window.destroyed).toBe(false);
        // And the unfenced-close guard is restored, so a later user close still
        // goes through a fresh fence rather than tearing down unfenced. Asserted
        // on the flag itself: `closeCalls` only proves `close()` ran, which is
        // true either way and says nothing about the guard.
        expect(window.closeCalls).toBeGreaterThan(0);
        expect(viewer_entry(viewer_manager, '/tmp/late-veto.csv').allowClose).toBe(false);
    });

    // The worst failure in this function, because it loses work rather than
    // merely hanging. `allowClose` is set immediately before `close()`, and only
    // the veto branch put it back — so a `close()` that *threw* left the guard
    // latched on. The user then sees "could not safely close this window… the
    // window will remain open so you can retry", retries, and the `close`
    // listener at window creation sees `allowClose === true` and returns early:
    // no flush request, no controller drain, no acknowledgement, window gone.
    // Unacknowledged `pendingEdits` can be the only copy of unsaved CSV work, and
    // the reassuring dialog is what makes it a trap rather than a visible error.
    it('re-arms the unfenced-close guard when close() throws', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/close-throws.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        window.closeThrows = true;

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

        // The fence reports failure and the window stays open, as the dialog says.
        await expect(closing).resolves.toBe(false);
        await vi.waitFor(() => expect(electron_mock.dialog.showMessageBox).toHaveBeenCalled());
        expect(window.destroyed).toBe(false);

        // The retry the dialog invited must go through a *fresh* fence. Before
        // this was fixed it tore the window down with no flush at all.
        window.closeThrows = false;
        window.close();
        await vi.waitFor(() => expect(window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        )).toHaveLength(2));
        expect(window.destroyed).toBe(false);
    });

    // The remaining way the fence could wait forever: the close event dispatches,
    // nobody vetoes it, and the window is still never destroyed — which is what
    // Chromium does for a renderer holding a `beforeunload` handler when the main
    // process registers no `will-prevent-unload` listener. The old code read "not
    // vetoed" and waited for a `closed` that never comes, so `close_all` never
    // settled, the quit barrier never finished, admission was never restored, and
    // the app could neither quit nor open files.
    it('settles rather than hanging when a close dispatches but never completes', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/close-stalls.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        window.closeStalls = true;

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

        // Settles at all — the property that was broken — and settles false,
        // because the window is demonstrably staying open.
        await expect(closing).resolves.toBe(false);
        expect(window.destroyed).toBe(false);
        // And the guard is re-armed, so the user's next close is fenced afresh
        // rather than tearing the window down unfenced.
        window.closeStalls = false;
        window.close();
        await vi.waitFor(() => expect(window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        )).toHaveLength(2));
    });

    // The fourth defect, and the one that motivated turning the fence into an
    // explicit state machine. `close()` destroys the window and *then* throws:
    // `closed` has already fired, so the fence has already settled `true` and the
    // close really did succeed — but the `catch` re-raised unconditionally, so
    // `start_lifecycle` also showed "Table Viewer could not safely close this
    // window." One invocation, two terminal outcomes that contradict each other,
    // and a user told a successful close had failed. A retry would then re-fence
    // an already-destroyed window.
    //
    // The exception is not swallowed: a teardown listener that throws is a real
    // fault worth seeing. It is reported rather than promoted to the close's own
    // outcome, because the close is not what failed.
    // Run in both destruction orderings, because they failed differently and only
    // one is macOS's real behaviour. With a synchronous destroy the promise had
    // already resolved, so the throw was swallowed by the executor — the outcome
    // was right but a genuine teardown fault vanished without trace. With an
    // asynchronous destroy — what macOS actually does — the throw beat the
    // destruction, the promise *rejected*, the failure dialog appeared, and the
    // window was destroyed anyway. That is the contradiction.
    it.each([false, true])(
        'reports one outcome when close() destroys the window and then throws (async=%s)',
        async (close_async) => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const viewer_manager = manager();
            viewer_manager.open_file('/tmp/close-throws-after-destroy.csv');
            const window = latest_window();
            emit_webview(window, { type: 'ready' });
            window.closeAsync = close_async;
            window.closeThrowsAfterDestroy = true;

            const closing = viewer_manager.close_all();
            const request = window.webContents.sent.filter(
                ({ message }) => message.type === 'requestPendingEditsFlush',
            ).at(-1)?.message;
            if (request?.type !== 'requestPendingEditsFlush') {
                throw new Error('missing flush request');
            }
            emit_webview(window, {
                type: 'pendingEditsFlush',
                requestId: request.requestId,
                highestProducedSequence: 0,
            });

            // The window closed, so that is the outcome — the promise says so.
            await expect(closing).resolves.toBe(true);
            expect(window.destroyed).toBe(true);
            // And the user is not told otherwise.
            expect(electron_mock.dialog.showMessageBox).not.toHaveBeenCalled();
            // The throw is surfaced, just not as the close's verdict: a teardown
            // listener that fails is a real fault, and the synchronous ordering
            // used to discard it entirely.
            expect(errors).toHaveBeenCalled();
        } finally {
            errors.mockRestore();
        }
    });

    // The remaining terminal shapes, as explicit cases rather than as properties
    // that happen to hold. The fence has exactly three outcomes and five ways to
    // reach them; four rounds of defects here were each one unreached combination,
    // so the combinations are enumerated and asserted rather than reasoned about.

    // `will-prevent-unload` arriving a tick after `close()` returns, rather than
    // synchronously inside it — same cancellation, later delivery.
    it('settles refused when the unload cancellation arrives asynchronously', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/late-prevent-unload.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        // Neither destroys nor vetoes: the cancellation is delivered afterwards.
        window.closeStalls = true;
        window.close = (() => {
            window.closeCalls += 1;
            window.emit('close', {
                defaultPrevented: false,
                preventDefault(this: { defaultPrevented: boolean }) {
                    this.defaultPrevented = true;
                },
            });
            queueMicrotask(() => window.webContents.emit('will-prevent-unload', {
                defaultPrevented: false,
                preventDefault(this: { defaultPrevented: boolean }) {
                    this.defaultPrevented = true;
                },
            }));
        }) as typeof window.close;

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

        await expect(closing).resolves.toBe(false);
        expect(window.destroyed).toBe(false);
    });

    // A `closed` event for a window that is not destroyed — a stray signal must
    // not be able to un-settle a verdict already reached, and must not be taken as
    // proof of a close that did not happen.
    it('ignores a spurious closed event after the fence has settled', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/spurious-closed.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        window.closeStalls = true;

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
        await expect(closing).resolves.toBe(false);

        // Arrives after the verdict. The settle guard makes it a no-op, and the
        // fence has already stopped listening.
        window.emit('closed');
        expect(window.destroyed).toBe(false);
    });

    // The guard the whole state machine rests on: `settle` transitions once, and
    // every later call is inert. Asserted through `allowClose` rather than through
    // the promise, because the promise cannot show it — a second `resolve` is
    // silently ignored by the promise itself, so the resolved value looks
    // identical whether or not the guard exists. `allowClose` is the side effect
    // that is *not* idempotent: a second `settle({type:'refused'})` after a
    // successful close would re-arm the fence guard on a destroyed window, which
    // is the exact flag the pendingEdits data-loss fix depends on.
    //
    // The path is real rather than contrived. `stop_observing` skips removing the
    // `will-prevent-unload` listener when the webContents is already destroyed —
    // which is precisely the case after a successful close — so that listener
    // genuinely outlives the settled fence and a later emit really does re-enter
    // `settle`.
    it('ignores a second settle signal after the window has closed', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/settle-once.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        // Captured before the close: a successful `close_all` tears the entry out
        // of the manager, so looking it up afterwards finds nothing. The object
        // itself is what the fence mutates, and it outlives that removal.
        const entry = viewer_entry(viewer_manager, '/tmp/settle-once.csv');

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
        expect(window.destroyed).toBe(true);
        // A close that succeeded leaves the guard disarmed: the window is gone,
        // and nothing may re-arm it.
        expect(entry.allowClose).toBe(true);

        // Every signal that could reach a settled fence, fired after the verdict.
        window.webContents.emit('will-prevent-unload', {
            defaultPrevented: false,
            preventDefault(this: { defaultPrevented: boolean }) {
                this.defaultPrevented = true;
            },
        });
        window.emit('closed');

        // Unchanged. Without the `settled` guard the refused branch would have set
        // this to false, contradicting a close that really happened.
        expect(entry.allowClose).toBe(true);
        await expect(closing).resolves.toBe(true);
    });

    // The verdict comes from the window's own state, never from the path taken to
    // reach it. This is the property behind defect 4 — "whether the close
    // succeeded is decided by the window, not by the presence of an exception" —
    // and until now nothing enforced it: forcing the post-`close()` check to
    // ignore `isDestroyed()` left every test green.
    //
    // A silent destruction is the only shape that can prove it, because it is the
    // only one where the window's state and its event stream disagree: the window
    // is gone, but no `closed` was ever emitted, so a fence that trusted events
    // alone would call a completed close a refusal — and, worse, re-arm
    // `allowClose` on a destroyed window.
    it('reports closed for a window destroyed without emitting closed', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/silent-destroy.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        const entry = viewer_entry(viewer_manager, '/tmp/silent-destroy.csv');
        window.closeDestroysSilently = true;

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
        expect(window.destroyed).toBe(true);
        // `allowClose` stays true: the outcome is `closed`, and only a window
        // that survives has the guard restored to false.
        expect(entry.allowClose).toBe(true);
        expect(electron_mock.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    // The same verdict rule on the throwing path, which has its own `isDestroyed`
    // check and its own mutant. A window destroyed silently *and* a throw on the
    // way out: the close still succeeded, so the exception is a teardown fault to
    // report, not a reason to tell the user the window would not close.
    it('reports closed when a silent destruction is followed by a throw', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const viewer_manager = manager();
            viewer_manager.open_file('/tmp/silent-destroy-throw.csv');
            const window = latest_window();
            emit_webview(window, { type: 'ready' });
            const entry = viewer_entry(viewer_manager, '/tmp/silent-destroy-throw.csv');
            window.close = (() => {
                window.closeCalls += 1;
                window.destroyed = true;
                window.webContents.destroyed = true;
                throw new Error('teardown listener failed');
            }) as typeof window.close;

            const closing = viewer_manager.close_all();
            const request = window.webContents.sent.filter(
                ({ message }) => message.type === 'requestPendingEditsFlush',
            ).at(-1)?.message;
            if (request?.type !== 'requestPendingEditsFlush') {
                throw new Error('missing flush request');
            }
            emit_webview(window, {
                type: 'pendingEditsFlush',
                requestId: request.requestId,
                highestProducedSequence: 0,
            });

            await expect(closing).resolves.toBe(true);
            expect(entry.allowClose).toBe(true);
            expect(electron_mock.dialog.showMessageBox).not.toHaveBeenCalled();
            expect(errors).toHaveBeenCalled();
        } finally {
            errors.mockRestore();
        }
    });

    // The companion half for both verdict tests: a window that is genuinely still
    // alive when `close()` throws must reach `failed`, not `closed`. Without this,
    // the two tests above would pass against a fence that simply reported `closed`
    // unconditionally — which is exactly the mutant they exist to kill, inverted.
    it('reports failure when close() throws and the window survives', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/throw-survives.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        const entry = viewer_entry(viewer_manager, '/tmp/throw-survives.csv');
        window.closeThrows = true;

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

        await expect(closing).resolves.toBe(false);
        expect(window.destroyed).toBe(false);
        // Re-armed, because the window is staying: this is the pendingEdits guard.
        expect(entry.allowClose).toBe(false);
        // And the user is told, because unlike a post-close teardown fault this
        // really is a close that did not happen.
        await vi.waitFor(() => expect(electron_mock.dialog.showMessageBox).toHaveBeenCalled());
    });

    // The companion half, and the rule this PR keeps relearning: an assertion that
    // something does *not* happen is worthless without one proving it happens at
    // all. Here that means the `refused` branch really does re-arm `allowClose` —
    // so the test above is pinning idempotence rather than a side effect that
    // never fires in the first place.
    it('re-arms allowClose when the first settle is a refusal', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/settle-refused.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        window.closeStalls = true;
        const entry = viewer_entry(viewer_manager, '/tmp/settle-refused.csv');

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

        await expect(closing).resolves.toBe(false);
        // The action fires: a refusal disarms nothing and re-arms the guard.
        expect(entry.allowClose).toBe(false);
        expect(window.destroyed).toBe(false);
    });

    // The quit path over a mixed set: one window vetoes, one is cancelled by
    // Chromium. `close_all` must settle false without hanging on either.
    it('settles close_all when one window vetoes and another cancels its unload', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/mixed-veto.csv');
        const vetoing = latest_window();
        emit_webview(vetoing, { type: 'ready' });
        vetoing.on('close', (event: { preventDefault(): void }) => event.preventDefault());

        viewer_manager.open_file('/tmp/mixed-stall.csv');
        const stalling = latest_window();
        emit_webview(stalling, { type: 'ready' });
        stalling.closeStalls = true;

        const closing = viewer_manager.close_all();
        for (const window of [vetoing, stalling]) {
            const request = window.webContents.sent.filter(
                ({ message }) => message.type === 'requestPendingEditsFlush',
            ).at(-1)?.message;
            if (request?.type !== 'requestPendingEditsFlush') {
                throw new Error('missing flush request');
            }
            emit_webview(window, {
                type: 'pendingEditsFlush',
                requestId: request.requestId,
                highestProducedSequence: 0,
            });
        }

        await expect(closing).resolves.toBe(false);
        expect(vetoing.destroyed).toBe(false);
        expect(stalling.destroyed).toBe(false);
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

    it('closes an initial declined viewer asynchronously through the normal fence', async () => {
        const draining = deferred();
        controller_mock.controller.drain.mockImplementationOnce(() => draining.promise);
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/initial-declined.csv');
        const window = latest_window();

        expect(controller_mock.options.requestClose()).toBeUndefined();
        expect(window.destroyed).toBe(false);
        draining.resolve();

        await vi.waitFor(() => expect(window.destroyed).toBe(true));
        expect(window.destroyCalls).toBe(0);
        expect(controller_mock.controller.dispose).toHaveBeenCalledOnce();
    });

    it('destroys an initial declined viewer when the normal close is refused', async () => {
        const viewer_manager = manager();
        viewer_manager.open_file('/tmp/initial-declined-veto.csv');
        const window = latest_window();
        window.on('close', (event: { preventDefault(): void }) => event.preventDefault());

        controller_mock.options.requestClose();

        await vi.waitFor(() => expect(window.destroyed).toBe(true));
        expect(window.destroyCalls).toBe(1);
        expect(controller_mock.controller.dispose).toHaveBeenCalledOnce();
        expect(viewer_manager.has_windows()).toBe(false);
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

describe('what the Edit menu is told about a viewer s history', () => {
    it('retains the state per window and rebuilds for the focused one', () => {
        const rebuilt: ElectronBrowserWindow[] = [];
        const viewer_manager = manager(undefined, (window) => { rebuilt.push(window); });
        viewer_manager.open_file('/tmp/a.csv');
        const first = latest_window();
        viewer_manager.open_file('/tmp/b.csv');
        const second = latest_window();

        emit_webview(first, {
            type: 'historyMenuStateChanged',
            state: {
                undoAvailable: true,
                redoAvailable: false,
                undoLabel: 'Paste',
                textEditing: false,
            },
        });

        // Retained against the window that reported it, and only that one: the
        // menu shows the focused window's history, and two files have two.
        expect(viewer_manager.history_menu_state(first as unknown as ElectronBrowserWindow))
            .toMatchObject({ undoAvailable: true, undoLabel: 'Paste' });
        expect(viewer_manager.history_menu_state(second as unknown as ElectronBrowserWindow))
            .toBeUndefined();
        expect(rebuilt).toHaveLength(1);
    });

    it('drops a malformed payload rather than retaining it', () => {
        const rebuilt: ElectronBrowserWindow[] = [];
        const viewer_manager = manager(undefined, (window) => { rebuilt.push(window); });
        viewer_manager.open_file('/tmp/bad.csv');
        const window = latest_window();

        emit_webview(window, {
            type: 'historyMenuStateChanged',
            state: { undoAvailable: 'yes' } as never,
        });

        expect(viewer_manager.history_menu_state(window as unknown as ElectronBrowserWindow))
            .toBeUndefined();
        // And no rebuild either: the menu it would build is the one already up.
        expect(rebuilt).toEqual([]);
    });

    it('stops listening once the window is gone', async () => {
        // The watcher is on the shared ipcMain channel, so a torn-down window that
        // kept listening would keep answering for a webContents nobody owns.
        const rebuilt: ElectronBrowserWindow[] = [];
        const viewer_manager = manager(undefined, (window) => { rebuilt.push(window); });
        viewer_manager.open_file('/tmp/gone.csv');
        const window = latest_window();
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
        expect(window.destroyed).toBe(true);

        emit_webview(window, {
            type: 'historyMenuStateChanged',
            state: {
                undoAvailable: true,
                redoAvailable: false,
                textEditing: false,
            },
        });
        expect(rebuilt).toEqual([]);
    });
});

describe('application quit coordinator', () => {
    // Regression for the macOS double-Quit bug. The resumed app.quit() used to
    // leave Electron in charge of closing the remaining app-chrome windows. The
    // observed result was a first Quit that destroyed the launcher but left the
    // process alive. The resumed quit must instead see an empty WindowList.
    it('closes every BrowserWindow before resuming the first quit', async () => {
        const calls: string[] = [];
        const launcher = new electron_mock.BrowserWindow({});
        launcher.closeAsync = true;
        launcher.on('close', () => { calls.push('launcher:close'); });
        launcher.on('closed', () => { calls.push('launcher:closed'); });

        const close_viewers = vi.fn(async () => {
            calls.push('viewers:closed');
            return true;
        });
        const shutdown = shutdown_port(async () => {
            calls.push('drain');
            return { type: 'closed' };
        });
        const resume_quit = vi.fn(() => {
            calls.push('resume');
            // This is the invariant Electron itself needs: no close event can now
            // cancel the resumed quit and consume the user's first Cmd-Q.
            expect(electron_mock.BrowserWindow.instances
                .filter((window) => !window.isDestroyed())).toEqual([]);
        });
        const before_quit = create_app_quit_coordinator(
            () => close_desktop_windows(
                close_viewers,
                () => electron_mock.BrowserWindow.instances as unknown as ElectronBrowserWindow[],
            ),
            resume_quit,
            shutdown,
        );

        before_quit({ preventDefault: vi.fn() });

        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        expect(calls).toEqual([
            'viewers:closed',
            'launcher:close',
            'launcher:closed',
            'drain',
            'resume',
        ]);
    });

    it('keeps quitting retryable when an app-chrome window refuses to close', async () => {
        const launcher = new electron_mock.BrowserWindow({});
        launcher.on('close', (event: { preventDefault(): void }) => event.preventDefault());
        const shutdown = shutdown_port(async () => ({ type: 'closed' }));
        const resume_quit = vi.fn();
        const close_windows = () => close_desktop_windows(
            async () => true,
            () => electron_mock.BrowserWindow.instances as unknown as ElectronBrowserWindow[],
        );
        const before_quit = create_app_quit_coordinator(
            close_windows,
            resume_quit,
            shutdown,
        );

        before_quit({ preventDefault: vi.fn() });

        await vi.waitFor(() => expect(shutdown.abandon).toHaveBeenCalledOnce());
        expect(launcher.destroyed).toBe(false);
        expect(shutdown.drain).not.toHaveBeenCalled();
        expect(resume_quit).not.toHaveBeenCalled();
    });

    it('waits for every app-chrome close before abandoning after one throws', async () => {
        const throwing = new electron_mock.BrowserWindow({});
        throwing.closeThrows = true;
        const slow = new electron_mock.BrowserWindow({});
        const slow_close = vi.fn(() => {
            const event = {
                defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; },
            };
            slow.emit('close', event);
            // The close is now in flight. The test emits `closed` explicitly after
            // proving the first failure did not make Promise.all abandon early.
        });
        slow.close = slow_close;

        const shutdown = shutdown_port(async () => ({ type: 'closed' }));
        const before_quit = create_app_quit_coordinator(
            () => close_desktop_windows(
                async () => true,
                () => electron_mock.BrowserWindow.instances as unknown as ElectronBrowserWindow[],
            ),
            vi.fn(),
            shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(slow_close).toHaveBeenCalledOnce());
        // The throwing window has already failed, but the other close operation
        // still owns part of the barrier. Admission must not reopen underneath it.
        expect(shutdown.abandon).not.toHaveBeenCalled();

        slow.destroyed = true;
        slow.webContents.destroyed = true;
        slow.webContents.emit('destroyed');
        slow.emit('closed');

        await vi.waitFor(() => expect(shutdown.abandon).toHaveBeenCalledOnce());
        expect(shutdown.drain).not.toHaveBeenCalled();
    });

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

    // The whole quit path over a *real* window, so the ordering asserted is the
    // one the app performs rather than one a stubbed `close_viewers` asserts
    // about itself: the renderer's flush is answered, its acknowledgement receipt
    // comes back, the controller drains, and only then is the window destroyed —
    // and only after that is the connection released. Every step before the drain
    // is what makes an acknowledged edit durable; a drain that overtook any of
    // them would close the store out from under the write it was waiting for.
    it('acknowledges the renderer, closes the window, and only then drains', async () => {
        const store_events: string[] = [];
        const store = {
            close: async (): Promise<void> => { store_events.push('store:close'); },
        };
        const wiring = real_shutdown(store);
        await wiring.publish();
        wiring.lifecycle.become_ready();
        wiring.viewer_manager.open_file('/tmp/quit-ack-order.csv');
        const window = latest_window();
        emit_webview(window, { type: 'ready' });
        const resume_quit = vi.fn(() => { store_events.push('resume'); });
        const before_quit = create_app_quit_coordinator(
            () => wiring.viewer_manager.close_all(),
            resume_quit,
            wiring.shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        // The barrier is open on the renderer, not on a timer: nothing has closed
        // and nothing has drained while the flush request is outstanding.
        const request = window.webContents.sent.filter(
            ({ message }) => message.type === 'requestPendingEditsFlush',
        ).at(-1)?.message;
        if (request?.type !== 'requestPendingEditsFlush') throw new Error('missing flush request');
        expect(window.destroyed).toBe(false);
        expect(store_events).toEqual([]);

        emit_webview(window, {
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: 'edit:quit',
            highestProducedSequence: 7,
        });
        // The acknowledgement has to reach the *page*, not merely be sent: the
        // desktop receipt is what proves delivery, and the close waits for it.
        await vi.waitFor(() => expect(controller_mock.panel).toBeDefined());
        controller_mock.panel.webview.postMessage({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'edit:quit',
            sequence: 7,
        });
        expect(window.destroyed).toBe(false);
        expect(store_events).toEqual([]);

        acknowledge_last_delivery(window);
        await vi.waitFor(() => expect(window.destroyed).toBe(true));
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        // The window was gone before the connection was released, and the quit
        // resumed only after both.
        expect(store_events).toEqual(['store:close', 'resume']);
        expect(wiring.backend.published).toBeUndefined();
    });

    // The narrower half of the mid-barrier race: not a request arriving while the
    // close fence runs (covered above), but one arriving after every window has
    // closed and while the connection is being released. There is no window left
    // to veto, so nothing would fence it — it would attach a controller to a
    // store that is mid-close, which is the same defect one tick later.
    it('refuses a window request arriving between the close fence and the drain', async () => {
        const draining = deferred();
        const store = {
            close: async (): Promise<void> => { await draining.promise; },
        };
        const wiring = real_shutdown(store);
        await wiring.publish();
        wiring.lifecycle.become_ready();
        const resume_quit = vi.fn();
        const before_quit = create_app_quit_coordinator(
            () => wiring.viewer_manager.close_all(),
            resume_quit,
            wiring.shutdown,
        );

        before_quit({ preventDefault: vi.fn() });
        // Inside the drain: the close fence is done (no windows to close) and the
        // store's close has been entered but not settled.
        await vi.waitFor(() => expect(wiring.backend.draining).toBe(true));
        expect(resume_quit).not.toHaveBeenCalled();

        expect(wiring.viewer_manager.open_file('/tmp/during-drain.csv')).toBeUndefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(0);
        let submitted = 0;
        wiring.lifecycle.submit(() => { submitted += 1; });
        expect(submitted).toBe(0);

        draining.resolve();
        await vi.waitFor(() => expect(resume_quit).toHaveBeenCalledOnce());
        // Still refused after the drain settles — a completed quit never re-admits.
        expect(wiring.viewer_manager.open_file('/tmp/after-drain.csv')).toBeUndefined();
        expect(electron_mock.BrowserWindow.instances).toHaveLength(0);
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
