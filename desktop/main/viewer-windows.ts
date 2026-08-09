// One window per open file. Each viewer window is a plain BrowserWindow whose
// page is the shared webview bundle, wired to the shared viewer controller
// (`attach_viewer`) through a per-window IPC transport.
//
// Windows rather than tabs: a spreadsheet can then be resized, moved, and shown
// side by side with another one, which is both more flexible and what an Excel
// user expects. It also means the window *is* the view — no tab strip to lay
// out around, and zoom is simply per-window.
import * as path from 'path';
import {
    BrowserWindow,
    dialog,
    ipcMain,
    nativeTheme,
    screen,
} from 'electron';
import {
    attach_viewer,
    profile_for,
    type ViewerController,
} from '../../src/viewer-controller';
import type { AuthorityFileStateStore } from '../../src/state';
import type { ViewerHost } from '../../src/host-ports';
import { canonical_file_key } from '../../src/resource-identity';
import { node_file_refresh_watcher_factory } from '../../src/node-file-refresh-watcher';
import type { HostMessage, WebviewMessage } from '../../src/types';
import { create_desktop_ui_port, node_file_system_port } from './desktop-host-ports';
import type { DesktopConfigStore } from './desktop-config';
import {
    create_viewer_panel,
    type DesktopViewerPanel,
    type ViewerPanelDeadlineScheduler,
} from './viewer-panel';
import { dirty_from_host_message, dirty_from_webview_message } from './dirty-state';
import type { DesktopDrainOutcome } from './desktop-lifecycle';
import { resolve_theme_id, window_background_color, type ThemePayload } from './theme';
import {
    CHANNEL_HOST_MESSAGE,
    CHANNEL_HOST_MESSAGE_RECEIPT,
    CHANNEL_WEBVIEW_MESSAGE,
    type DesktopHostMessageEnvelope,
    type PendingEditAcknowledgementReceipt,
} from '../shared/ipc';
import { viewer_url } from './viewer-html';
import {
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    next_window_bounds,
    type WindowSize,
} from './window-geometry';

interface ViewerWindow {
    readonly fileKey: string;
    readonly window: BrowserWindow;
    readonly panel: DesktopViewerPanel;
    readonly controller: ViewerController;
    /** One serialized flush/drain barrier shared by reload, close, and app quit. */
    lifecycle?: {
        promise: Promise<boolean>;
        intent: 'reload' | 'close';
        ignoreCache: boolean;
    };
    /** Set only after the renderer acknowledgement and controller drain succeed. */
    allowClose: boolean;
    /** Drops the unsaved-edits watcher (see `dirty_from_webview_message`). */
    readonly stop_watching_dirty: () => void;
    /** Drops renderer navigation/process/transport lifecycle watchers. */
    readonly stop_watching_renderer: () => void;
    /** Persists a resize still inside its settle window, and cancels it.
     *  A no-op when nothing is pending. */
    readonly flush_size: () => void;
    /** Bumped on every resize of this window, whatever the mode — 0 until the
     *  first one. Creation order is not resize order, and the preference is
     *  about the window the user last *resized*; counting even under `fixed`,
     *  where no size is recorded at all, is what lets the switch back to
     *  `match-last` still find that window. */
    resize_seq: number;
}

const IS_MAC = process.platform === 'darwin';

/** How long a drag has to settle before the new size is persisted. A resize
 *  fires continuously, and each write is a synchronous rewrite of the settings
 *  file. */
const RESIZE_SETTLE_MS = 250;

/** Feeds the per-window viewer host (see `viewer_url`); never reused, so a
 *  closed window's zoom level is not inherited by the next one. */
let next_window_id = 1;

/**
 * The state backend as the quit barrier sees it: admission it can close and
 * reopen, a connection it can release, and a way to say that release failed.
 *
 * Separated from the concrete backend so the barrier stays electron-free and
 * store-free; main.ts binds it to `create_desktop_state_backend`.
 */
export interface AppQuitShutdownPort {
    /**
     * Stop admitting new controller and window work.
     *
     * Called on entry to the barrier, before the window-close fence — the fence
     * is asynchronous and the OS keeps delivering `open-file` throughout it, and
     * a window created in that gap is not in the fence's snapshotted list. It
     * would never be fenced, would survive the drain holding a controller over a
     * closed connection, and would then veto every later quit.
     */
    begin(): void;
    /** Undo `begin`, because a viewer vetoed its close and the app is staying
     *  up. Called from exactly one branch of the barrier — the one that runs
     *  before `drain` — and the barrier's promise chain is shaped so that no
     *  failure after the close can reach it. See `create_app_quit_coordinator`. */
    abandon(): void;
    /** Release the connection. Never rejects: the outcome is the value, because
     *  a failed close is terminal rather than retryable. */
    drain(): Promise<DesktopDrainOutcome>;
    /** Report a close that failed. The quit still proceeds — see the barrier. */
    report_close_failure(): void;
}

/**
 * Close the viewer windows through their durability fences, then close every
 * remaining BrowserWindow before Electron is asked to resume quitting.
 *
 * This ordering is load-bearing on macOS. Electron's native window-close phase
 * is stateful: a cancelled close clears its internal `is_quitting` flag, and the
 * observed failure mode was a first Cmd-Q that destroyed the launcher but left
 * the process alive until a second Cmd-Q. There is no reason to leave that final
 * close phase to Electron after the app has already taken ownership of an
 * asynchronous shutdown barrier.
 *
 * The first before-quit is therefore only the admission signal. We close and
 * observe every window ourselves, drain the backend, and resume `app.quit()`
 * only when Electron's WindowList is already empty.
 */
export async function close_desktop_windows(
    close_viewer_windows: () => Promise<boolean>,
    remaining_windows: () => readonly BrowserWindow[],
): Promise<boolean> {
    if (!await close_viewer_windows()) return false;

    const windows = remaining_windows().filter((window) => !window.isDestroyed());
    const closed = await Promise.all(
        windows.map((window) => close_plain_window(window).catch(() => false)),
    );
    return closed.every(Boolean);
}

/** Close an app-chrome window and settle from observed Electron events. */
function close_plain_window(window: BrowserWindow): Promise<boolean> {
    if (window.isDestroyed()) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        let dispatched: Electron.Event | undefined;
        const web_contents = window.webContents;

        const capture_event = (event: Electron.Event) => { dispatched = event; };
        const on_closed = () => settle(true);
        const on_prevent_unload = () => settle(false);

        function stop_observing(): void {
            window.removeListener('close', capture_event);
            window.removeListener('closed', on_closed);
            if (!web_contents.isDestroyed()) {
                web_contents.removeListener('will-prevent-unload', on_prevent_unload);
            }
        }

        function settle(closed: boolean): void {
            if (settled) return;
            settled = true;
            stop_observing();
            resolve(closed);
        }

        window.on('close', capture_event);
        window.once('closed', on_closed);
        if (!web_contents.isDestroyed()) {
            web_contents.on('will-prevent-unload', on_prevent_unload);
        }

        try {
            window.close();
        } catch (error) {
            if (window.isDestroyed()) settle(true);
            else {
                stop_observing();
                settled = true;
                reject(error);
            }
            return;
        }
        if (settled) return;
        if (window.isDestroyed()) {
            settle(true);
            return;
        }
        if (dispatched === undefined || dispatched.defaultPrevented) settle(false);
        // Otherwise destruction is asynchronous; `closed` settles the promise.
    });
}

/**
 * Coordinate Electron's synchronous before-quit event with the asynchronous
 * shutdown barrier: admission stops, then every app window closes (viewer
 * windows through their durability fences), then the state backend drains. The
 * resumed app.quit() call is admitted exactly once after all three; a vetoed
 * window close leaves quitting retryable *and* puts admission
 * back, because the app is staying up and one that has silently stopped opening
 * files is a worse outcome than the quit the user cancelled.
 *
 * A close that fails does not block the quit. That is not a relaxation of
 * durability: the close already ran, and both
 * `OpenedSqliteFileStateStore.close` and the runtime beneath it memoize their
 * promise, so a "retry" returns the same settled rejection without touching the
 * connection. Blocking would therefore buy nothing and cost everything — with
 * `allow_quit` still false, every later Cmd-Q re-entered a barrier that could
 * only fail identically, leaving force-quit as the only exit over a connection
 * that had already been closed. So the failure is reported and the quit
 * proceeds. A window *veto* is a different case and still blocks, because there
 * the app really can succeed on a retry.
 *
 * There is deliberately no "no viewer windows, quit immediately" fast path any
 * more, and no window-count probe of any kind. That shortcut was correct only
 * while the state backend was in-memory. With a real SQLite connection open, a
 * quit issued from the welcome window — or, on macOS, after the user closed
 * every viewer but left the app running — still has to release the connection,
 * the writer-session row and the leases it holds. Skipping the drain there
 * leaves those rows claimed by a process that no longer exists and can leave a
 * hot journal behind for the next launch to recover.
 *
 * So the barrier always runs both stages. Closing an empty window list already
 * resolves true having done nothing, which is exactly what a "there is nothing
 * to close" branch would have computed — a separate has-windows port was only a
 * second way to reach that answer, and a second way to get it wrong.
 */
export function create_app_quit_coordinator(
    close_windows: () => Promise<boolean>,
    resume_quit: () => void,
    shutdown: AppQuitShutdownPort = {
        begin: () => {},
        abandon: () => {},
        drain: () => Promise.resolve({ type: 'closed' }),
        report_close_failure: () => {},
    },
): (event: { preventDefault(): void }) => void {
    let allow_quit = false;
    let quit_barrier: Promise<void> | undefined;

    return (event) => {
        if (allow_quit) return;

        event.preventDefault();
        // Concurrent `before-quit` events (macOS delivers a second one) share the
        // one barrier, so admission is closed exactly once per barrier too.
        if (quit_barrier) return;
        // First, and synchronously with the event: everything after this point is
        // asynchronous, and the OS can deliver an `open-file` between any two
        // ticks of it. A window admitted after `close_windows` snapshots its list
        // is never fenced.
        shutdown.begin();
        quit_barrier = close_windows()
            // Scoped to the close fence alone, and deliberately not to the whole
            // chain: the fence is the one stage where a rejection means the same
            // thing as a veto (nothing has been closed, the app is staying up), so
            // it is folded into the same `false` here — before `drain` is even
            // reachable. A `.catch` further down would also cover the drain
            // callback, where `report_close_failure` (a console.error, which
            // throws on EPIPE) and `resume_quit` (app.quit()) run *after* the
            // connection is gone; abandoning there would re-admit `open_file` and
            // release buffered `open-file` work onto a closed, cleared store.
            .catch(() => false)
            .then((closed) => {
                // A viewer vetoed its close (unacknowledged edits, lost renderer),
                // an app-chrome window refused, or the close stage rejected. The
                // app is staying up, so the backend must stay open — draining it
                // would strand a window that
                // still holds an attached controller — and admission goes back,
                // because refusing to open files in an app the user just chose to
                // keep running is a bug of its own.
                if (!closed) {
                    shutdown.abandon();
                    return;
                }
                // Only after every viewer has finished its own flush/drain/ack
                // fence and every BrowserWindow is gone, so no controller can
                // still admit work and Electron's resumed quit has no close phase
                // left that could cancel it.
                return shutdown.drain().then((outcome) => {
                    // A failed close is terminal, not retryable: see the module
                    // comment above. Report it and quit anyway rather than trap
                    // the user in an app that can only be force-quit.
                    //
                    // Latched before the report, not after: reporting is I/O
                    // (console.error over a pipe the parent may have closed), and
                    // a throw there must not be what decides whether the app can
                    // ever quit again.
                    allow_quit = true;
                    if (outcome.type === 'close-failed') {
                        try {
                            shutdown.report_close_failure();
                        } catch {
                            // Best-effort, for the same reason the failed close
                            // does not block: the connection is already released,
                            // and a stdout that has gone away must not be what
                            // keeps the app on screen.
                        }
                    }
                    resume_quit();
                });
            })
            // before-quit cannot await this barrier, so every rejection has to be
            // consumed here to stay off the main process's unhandled-rejection
            // path. Consumed and nothing else: the only rejections that reach this
            // point come from after the connection closed (see above), and there is
            // no state left to put back — `allow_quit` is already latched and the
            // store is already released.
            .catch(() => {})
            .finally(() => {
                quit_barrier = undefined;
            });
    };
}

export class ViewerWindowManager {
    /** Open windows in the order they were created (the last one is cascaded
     *  from when the next window opens). */
    private readonly windows: ViewerWindow[] = [];
    /** Source of `ViewerWindow.resize_seq`; monotonic across all windows. */
    private resize_counter = 0;
    /** The sequence behind the size currently stored, so a write from an older
     *  resize arriving late (see `store_size`) can be recognized and dropped. */
    private last_stored_seq = 0;
    /** Set once shutdown has begun (see `stop_admission`). No new viewer may be
     *  attached to the state backend after that point. */
    private admitting = true;

    constructor(
        private readonly state_store: AuthorityFileStateStore,
        private readonly config_store: DesktopConfigStore,
        private readonly viewer_preload_path: string,
        private readonly viewer_panel_deadline_scheduler?: ViewerPanelDeadlineScheduler,
    ) {}

    /**
     * Show `file_path` in its own window, or focus the window already showing
     * it. Returns the window either way, or nothing once admission has stopped
     * (see `stop_admission`) — a file opened during shutdown is dropped rather
     * than attached to a backend that is already draining.
     */
    open_file(file_path: string): BrowserWindow | undefined {
        // Checked before the existing-window lookup as well: during the draining
        // phase even re-focusing is refused, because the OS can deliver an
        // open-file event at any moment and the answer has to be "not now"
        // uniformly rather than depending on which files happen to be open.
        if (!this.admitting) return undefined;
        const file_key = canonical_file_key(file_path);
        const existing = this.windows.find((entry) => entry.fileKey === file_key);
        if (existing) {
            const window = existing.window;
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
            return window;
        }

        const title = path.basename(file_path);
        const window = new BrowserWindow({
            ...this.bounds_for_new_window(),
            minWidth: MIN_WINDOW_WIDTH,
            minHeight: MIN_WINDOW_HEIGHT,
            title,
            // resolve_theme_id is the one place "which theme is active" is
            // decided (see theme-definitions.ts); main.ts wraps it too.
            backgroundColor: window_background_color(
                resolve_theme_id(this.config_store.settings(), nativeTheme.shouldUseDarkColors),
            ),
            webPreferences: {
                preload: this.viewer_preload_path,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        });
        const web_contents = window.webContents;
        if (process.platform === 'darwin') window.setRepresentedFilename(file_path);

        // Unsaved CSV edits accepted by the current state backend are tracked per file;
        // this indicator only makes them visible: macOS puts a dot in an edited document's
        // close button, and other platforms get a marked title.
        let dirty = false;
        const apply_window_state = () => {
            if (window.isDestroyed()) return;
            // The shared viewer page's <title> is the app name; the file name goes
            // in the title bar instead. Re-asserted rather than merely prevented:
            // the document title is adopted on load regardless.
            window.setTitle(!IS_MAC && dirty ? `• ${title}` : title);
            window.setDocumentEdited(dirty); // macOS only; a no-op elsewhere.
        };
        const set_dirty = (next: boolean | undefined) => {
            if (next === undefined || next === dirty) return;
            dirty = next;
            apply_window_state();
        };
        web_contents.on('page-title-updated', (event) => {
            event.preventDefault();
            apply_window_state();
        });

        // Per-window transport: host messages go out over this window's
        // webContents; webview messages come back on the shared channel,
        // filtered by sender. Renderer loss is a first-class transport event so
        // a close already waiting for a flush or acknowledgement cannot hang.
        const renderer_generation_listeners = new Set<(error: Error) => void>();
        const renderer_loss_listeners = new Set<(error: Error, retryable: boolean) => void>();
        const renderer_responsive_listeners = new Set<() => void>();
        const acknowledgement_receipt_listeners = new Set<(
            receipt: PendingEditAcknowledgementReceipt,
        ) => void>();
        const report_renderer_generation_change = () => {
            const error = new Error('Viewer renderer was replaced by a successful navigation.');
            for (const listener of [...renderer_generation_listeners]) listener(error);
        };
        const report_renderer_loss = (error: Error, retryable = false) => {
            for (const listener of [...renderer_loss_listeners]) listener(error, retryable);
        };
        const on_main_frame_navigated = () => report_renderer_generation_change();
        const on_failed_load = (
            _event: Electron.Event,
            error_code: number,
            error_description: string,
            validated_url: string,
            is_main_frame: boolean,
        ) => {
            if (!is_main_frame) return;
            report_renderer_loss(new Error(
                `Viewer navigation failed (${error_code} ${error_description}): ${validated_url}`,
            ));
        };
        const on_render_process_gone = (
            _event: Electron.Event,
            details: Electron.RenderProcessGoneDetails,
        ) => report_renderer_loss(new Error(
            `Viewer renderer terminated (${details.reason}, exit ${details.exitCode}).`,
        ));
        const on_transport_destroyed = () => report_renderer_loss(
            new Error('Viewer renderer transport was destroyed.'),
        );
        const on_unresponsive = () => report_renderer_loss(
            new Error('Viewer renderer became unresponsive.'),
            true,
        );
        const on_responsive = () => {
            for (const listener of [...renderer_responsive_listeners]) listener();
        };
        const acknowledgement_receipt_watcher = (
            event: Electron.IpcMainEvent,
            receipt: PendingEditAcknowledgementReceipt,
        ) => {
            if (event.sender !== web_contents) return;
            for (const listener of [...acknowledgement_receipt_listeners]) listener(receipt);
        };
        web_contents.on('did-navigate', on_main_frame_navigated);
        web_contents.on('did-fail-load', on_failed_load);
        web_contents.on('render-process-gone', on_render_process_gone);
        web_contents.on('destroyed', on_transport_destroyed);
        window.on('unresponsive', on_unresponsive);
        window.on('responsive', on_responsive);
        ipcMain.on(CHANNEL_HOST_MESSAGE_RECEIPT, acknowledgement_receipt_watcher);

        const panel = create_viewer_panel({
            send: (message: HostMessage, rendererGeneration, receipt) => {
                if (web_contents.isDestroyed()) {
                    report_renderer_loss(new Error('Viewer renderer transport was destroyed.'));
                    return false;
                }
                set_dirty(dirty_from_host_message(message));
                try {
                    const envelope: DesktopHostMessageEnvelope = {
                        rendererGeneration,
                        message,
                        receipt,
                    };
                    web_contents.send(CHANNEL_HOST_MESSAGE, envelope);
                    return true;
                } catch (error) {
                    report_renderer_loss(error instanceof Error
                        ? error
                        : new Error('Viewer renderer transport failed.'));
                    return false;
                }
            },
            on_message: (listener: (message: WebviewMessage) => void) => {
                const handler = (
                    event: Electron.IpcMainEvent,
                    message: WebviewMessage,
                ) => {
                    if (event.sender !== web_contents) return;
                    listener(message);
                };
                ipcMain.on(CHANNEL_WEBVIEW_MESSAGE, handler);
                return () => ipcMain.removeListener(CHANNEL_WEBVIEW_MESSAGE, handler);
            },
            on_renderer_generation_changed: (listener) => {
                renderer_generation_listeners.add(listener);
                return () => renderer_generation_listeners.delete(listener);
            },
            on_renderer_unavailable: (listener) => {
                renderer_loss_listeners.add(listener);
                return () => renderer_loss_listeners.delete(listener);
            },
            on_renderer_responsive: (listener) => {
                renderer_responsive_listeners.add(listener);
                return () => renderer_responsive_listeners.delete(listener);
            },
            on_pending_edit_ack_receipt: (listener) => {
                acknowledgement_receipt_listeners.add(listener);
                return () => acknowledgement_receipt_listeners.delete(listener);
            },
        }, this.viewer_panel_deadline_scheduler);

        // Watched independently of the panel's own subscriptions, which belong to
        // the controller and may come and go.
        const dirty_watcher = (
            event: Electron.IpcMainEvent,
            message: WebviewMessage,
        ) => {
            if (event.sender !== web_contents) return;
            set_dirty(dirty_from_webview_message(message));
        };
        ipcMain.on(CHANNEL_WEBVIEW_MESSAGE, dirty_watcher);

        // Format capabilities come from the same shared profile factory as the
        // VS Code extension: CSV/TSV are editable, while Excel remains read-only.
        const controller = attach_viewer(
            panel,
            file_path,
            this.state_store,
            profile_for(file_path, this.config_store.config_port()),
            this.viewer_host(window),
        );

        // Track the size as the user drags, not only on close: opening a second
        // file without closing the first should still match the size just set.
        let settle_timer: ReturnType<typeof setTimeout> | undefined;
        /** A resize waiting out the settle window, with the sequence it had —
         *  `store_size` needs the latter to reject it if something newer has
         *  been recorded in the meantime. */
        let pending: { size: WindowSize; seq: number } | undefined;
        /** The last size this window was seen at, so a `resize` that does not
         *  actually change the size can be told apart from one that does. */
        let last_size: WindowSize = window.getBounds();
        const cancel_settle = () => {
            if (settle_timer) clearTimeout(settle_timer);
            settle_timer = undefined;
        };

        const entry: ViewerWindow = {
            fileKey: file_key,
            window,
            panel,
            controller,
            allowClose: false,
            stop_watching_dirty: () =>
                ipcMain.removeListener(CHANNEL_WEBVIEW_MESSAGE, dirty_watcher),
            stop_watching_renderer: () => {
                web_contents.removeListener('did-navigate', on_main_frame_navigated);
                web_contents.removeListener('did-fail-load', on_failed_load);
                web_contents.removeListener('render-process-gone', on_render_process_gone);
                web_contents.removeListener('destroyed', on_transport_destroyed);
                window.removeListener('unresponsive', on_unresponsive);
                window.removeListener('responsive', on_responsive);
                ipcMain.removeListener(CHANNEL_HOST_MESSAGE_RECEIPT, acknowledgement_receipt_watcher);
                renderer_generation_listeners.clear();
                renderer_loss_listeners.clear();
                renderer_responsive_listeners.clear();
                acknowledgement_receipt_listeners.clear();
            },
            flush_size: () => {
                if (!pending) return;
                cancel_settle();
                const { size, seq } = pending;
                pending = undefined;
                this.store_size(size, seq);
            },
            resize_seq: 0,
        };
        this.windows.push(entry);
        window.on('resize', () => {
            // Maximizing, going fullscreen and minimizing all fire this on some
            // platforms. None of them is the user choosing a size, so they must
            // not count as one — neither recorded, nor allowed to make this the
            // most recently resized window.
            if (window.isMaximized() || window.isFullScreen() || window.isMinimized()) return;
            const bounds = window.getBounds();
            // Nor is landing back on the size this window already had, which is
            // what *restoring* from those states does — by then the flags above
            // have cleared, so the size is the only thing left to tell the two
            // apart. Also covers the events a window emits as it is created.
            if (bounds.width === last_size.width && bounds.height === last_size.height) return;
            last_size = { width: bounds.width, height: bounds.height };
            entry.resize_seq = ++this.resize_counter;
            // Measured now rather than when the timer fires: the user can
            // maximize or minimize inside the settle window, and the size they
            // just dragged to would be unreadable by then. The debounce is only
            // about how often it is written.
            pending = { size: last_size, seq: entry.resize_seq };
            cancel_settle();
            settle_timer = setTimeout(() => {
                settle_timer = undefined;
                entry.flush_size();
            }, RESIZE_SETTLE_MS);
        });
        // Only a drag that has not settled yet: a window closing is not itself
        // a size the user chose, and recording it would overwrite the size they
        // did choose in some other window. 'closed' is where the controller and
        // its subscriptions go away.
        window.on('close', (event) => {
            entry.flush_size();
            if (entry.allowClose) return;
            event.preventDefault();
            void this.close_entry(entry);
        });
        window.once('closed', () => this.teardown(entry));
        // Closing the window mid-load aborts the navigation, which rejects; an
        // unhandled rejection in the main process is fatal, so swallow it.
        web_contents.loadURL(viewer_url(next_window_id++)).catch((error) => {
            if (!window.isDestroyed()) console.error('Failed to load the viewer', error);
        });
        return window;
    }

    /** Whether any file is open, i.e. the app has a document window on screen. */
    has_windows(): boolean {
        return this.windows.length > 0;
    }

    /**
     * Enter the draining phase: `open_file` becomes a no-op, so no window — and
     * therefore no controller and no backend work — can join after the quit
     * barrier has begun.
     *
     * Called on *entry* to the barrier, before the window-close fence, not after
     * it: the fence is asynchronous, the OS keeps delivering `open-file`
     * throughout it, and `close_all` snapshots its entry list — so a window
     * admitted in that gap is never fenced at all, survives the drain holding a
     * controller over a closed connection, and then vetoes every later quit.
     *
     * Reversible, but only through `resume_admission`, and only for a barrier
     * that ended before the connection closed. See that method for why.
     *
     * Everything already open keeps working: `has_windows` and `close_all` are
     * how the barrier drives those windows to completion.
     *
     * Kept as defense in depth even though every current caller of `open_file`
     * is already inside `lifecycle.submit`, which refuses work once draining.
     * The two gates guard different things and are not interchangeable: the
     * lifecycle gate stops *requests* reaching this class, while this flag is the
     * class's own refusal to attach a controller to a connection that is closing
     * — the invariant that must hold for any future call site, including one that
     * reaches `open_file` without going through the gate. It is also what makes
     * `open_file`'s `undefined` return meaningful, which is how `open_files` in
     * main.ts knows not to close the launcher it was invoked from.
     */
    stop_admission(): void {
        this.admitting = false;
    }

    /**
     * Admit windows again, because the quit that stopped them will not happen.
     *
     * Narrowly safe, and only for the one caller that owns the ordering: the quit
     * coordinator, on the path where `close_all` answered false (a viewer vetoed
     * its close) or the fence itself rejected. Both are decided *before* the drain
     * runs, so the connection this manager reads through has not been touched —
     * which is the whole precondition. Calling it after a drain would be exactly
     * the bug `stop_admission` exists to prevent: a viewer attached to a connection
     * that is closing or closed.
     *
     * That precondition is not left to the caller's good behaviour. The barrier's
     * close-fence `.catch` is scoped so no post-close failure can route here, and
     * `create_desktop_state_backend`'s `abandon_shutdown` — the only thing in the
     * app that calls this method — is a hard no-op once a close has been attempted.
     * The method itself is a plain setter, so the enforcement has to live upstream;
     * these are the two places it does.
     *
     * It exists because the alternative is worse than the risk it carries. A
     * vetoed close leaves the app running, and leaving admission off there gives
     * the user an app that silently ignores every Finder double-click, with no
     * message and no way back short of quitting — the thing they just declined to
     * do.
     */
    resume_admission(): void {
        this.admitting = true;
    }

    /** Close every viewer through the same renderer/backend fence as native close. */
    async close_all(): Promise<boolean> {
        const entries = this.windows.filter((entry) => !entry.window.isDestroyed());
        const closed = await Promise.all(entries.map((entry) => this.close_entry(entry)));
        return closed.every(Boolean);
    }

    /**
     * Route a menu reload through flush → drain → acknowledgement → drain.
     * Returns false for non-viewer windows so main.ts can use native reload there.
     */
    reload(window: BrowserWindow, ignore_cache: boolean): boolean {
        const entry = this.windows.find((candidate) => candidate.window === window);
        if (!entry) return false;
        if (entry.lifecycle || window.isDestroyed()) return true;
        this.start_lifecycle(entry, 'reload', ignore_cache);
        return true;
    }

    /**
     * Hand a menu-issued Copy / Select All to `window`'s viewer, which routes it
     * to its focused text field or its grid. Returns false when `window` is not
     * a viewer window, so the caller can fall back to the native editing
     * command (see `route_edit_command` in main.ts).
     */
    send_edit_command(window: BrowserWindow, command: 'copy' | 'selectAll'): boolean {
        const entry = this.windows.find((candidate) => candidate.window === window);
        if (!entry || entry.window.webContents.isDestroyed()) return false;
        // postMessage is Thenable in the shared panel contract, but delivery to
        // a live window is what "claimed" means here.
        void entry.panel.webview.postMessage({ type: 'editCommand', command });
        return true;
    }

    /**
     * Repaint each viewer window's frame for a new OS appearance. Delivering the
     * palette to the pages themselves is main.ts's job — it broadcasts to every
     * window (viewer, welcome, preferences) in one pass.
     */
    apply_theme(payload: ThemePayload): void {
        for (const entry of this.windows) {
            if (!entry.window.isDestroyed()) {
                entry.window.setBackgroundColor(window_background_color(payload.themeId));
            }
        }
    }

    private async fence_renderer(entry: ViewerWindow): Promise<void> {
        const flush = await entry.panel.flush_pending_edits();
        await entry.controller.drain();
        await entry.panel.wait_for_pending_edit_ack(
            flush.rendererGeneration,
            flush.editSessionId,
            flush.sequence,
        );
        // Acknowledgement delivery is downstream of persistence, but other admitted
        // controller work may have joined while the renderer was flushing.
        await entry.controller.drain();
    }

    /**
     * Close a window whose renderer/backend fence has already completed, and
     * report whether it really closed.
     *
     * A small state machine rather than a chain of conditionals, because this is
     * the fifth revision of it and each of the previous four fixed one ordering
     * while leaving another broken. The shape is what keeps it correct:
     *
     * - exactly three terminal outcomes — `closed`, `refused`, `failed`;
     * - one guarded transition (`settle`) that ignores every call after the
     *   first, so no ordering can produce two verdicts or two settlements;
     * - every branch ends by naming its outcome, so "what happens if…" is
     *   answered by reading the enum rather than by simulating the control flow.
     *
     * Three properties must survive any future edit:
     *
     * 1. **It always settles.** No branch may wait for an event that might not
     *    come. There is deliberately no deadline: a slow-but-successful close has
     *    to resolve `true`, so every terminal is driven by an observed event.
     * 2. **It never reports `closed` for a window that is staying open**, and
     *    never reports otherwise for one that is gone. The verdict follows
     *    observed reality — `isDestroyed()` — not the path taken to reach it.
     * 3. **`allowClose` is re-armed on every outcome except `closed`.** That flag
     *    disarms the creation-time guard that fences user-initiated closes; left
     *    latched, the next close tears the window down with no renderer flush and
     *    no acknowledgement, discarding `pendingEdits` that may be the only copy
     *    of unsaved CSV work.
     *
     * One residual is accepted deliberately. A close that dispatches its event,
     * is vetoed by nobody, produces no `will-prevent-unload`, and then never
     * destroys the window would not settle. That state is *indistinguishable
     * from a slow-but-successful close* — both look like "dispatched, nobody
     * objected, waiting" — so no observation can separate them, and the only
     * mechanism that could is a deadline. A deadline would resolve the slow case
     * wrongly, which is the worse trade: reporting a veto for a window that is
     * closing normally is how the packaged app became unquittable in the first
     * place. Every terminal state Electron actually reaches emits one of the
     * three signals below, so this path is not known to occur; it is recorded
     * because it is the one hole the enumeration cannot close by construction.
     *
     * The three signals it reads, and why each is needed:
     *
     * - **`closed`** — the only proof a close finished. On macOS `close()` returns
     *   with the window still alive and destroys it a tick later, so a synchronous
     *   `isDestroyed()` probe reports every successful close as a veto.
     * - **the `close` event object, inspected after dispatch** — Electron passes
     *   one object to every listener in registration order, so a veto is only
     *   fully known once they have all run. Reading it from inside a listener sees
     *   only the vetoes that preceded that listener.
     * - **`will-prevent-unload`** — Chromium cancelling on the renderer's behalf
     *   (a `beforeunload` handler) produces a `close` event nobody vetoed followed
     *   by a window that is never destroyed. This is the only in-band signal for
     *   it, and without it that case waits forever.
     */
    private close_fenced_window(entry: ViewerWindow): Promise<boolean> {
        if (entry.window.isDestroyed()) return Promise.resolve(true);
        return new Promise<boolean>((resolve, reject) => {
            type Outcome =
                /** The window is gone. The only outcome that leaves `allowClose` set. */
                | { readonly type: 'closed' }
                /** The window is staying open, and this is not an error: a veto, or
                 *  Chromium cancelling the unload. Retryable by the user. */
                | { readonly type: 'refused' }
                /** `close()` itself raised before anything closed. */
                | { readonly type: 'failed'; readonly error: unknown };

            let settled = false;
            /** The event Electron dispatched, read after `close()` returns so that
             *  every listener — including any registered after this one — has had
             *  its chance to veto. */
            let dispatched: Electron.Event | undefined;

            const web_contents = entry.window.webContents;
            const capture_event = (event: Electron.Event) => { dispatched = event; };
            const on_closed = () => settle({ type: 'closed' });
            /** Deliberately not overridden with `preventDefault()`: forcing a close
             *  past a `beforeunload` is the renderer barrier's decision, not a
             *  shutdown fence's to make silently. */
            const on_prevent_unload = () => settle({ type: 'refused' });

            const stop_observing = () => {
                entry.window.removeListener('close', capture_event);
                entry.window.removeListener('closed', on_closed);
                if (!web_contents.isDestroyed()) {
                    web_contents.removeListener('will-prevent-unload', on_prevent_unload);
                }
            };

            /** The single transition out of "in progress". Every later call is a
             *  no-op, which is what makes a second signal — a late `closed`, a
             *  throw after destruction — unable to contradict the first. */
            function settle(outcome: Outcome): void {
                if (settled) return;
                settled = true;
                stop_observing();
                // Re-armed for every outcome but `closed`, so a window that is
                // still on screen is only ever torn down through a fresh fence.
                if (outcome.type !== 'closed') entry.allowClose = false;
                if (outcome.type === 'failed') reject(outcome.error);
                else resolve(outcome.type === 'closed');
            }

            // Registered before `close()`, because a synchronous destruction fires
            // `closed` from inside it.
            entry.window.on('close', capture_event);
            entry.window.once('closed', on_closed);
            if (!web_contents.isDestroyed()) {
                web_contents.on('will-prevent-unload', on_prevent_unload);
            }

            entry.allowClose = true;
            try {
                entry.window.close();
            } catch (error) {
                // Ordering matters here, and getting it wrong was the fourth
                // defect: the app's own `close` listener runs inside `close()`, so
                // a throw can surface either side of the destruction. Whether the
                // close succeeded is decided by the window, never by the presence
                // of an exception — a teardown fault is reported, not promoted
                // into a false "could not close this window".
                //
                // The verdict is taken one microtask later rather than
                // immediately, because at this instant an asynchronous destruction
                // may be queued but not yet run, and "still alive right now" would
                // read that as a failure. This is not a deadline: a microtask
                // always runs, `settle` is idempotent so a `closed` arriving first
                // simply wins, and nothing here waits on an event that may never
                // come.
                queueMicrotask(() => {
                    if (settled) {
                        console.error('Viewer window teardown failed after it closed', error);
                        return;
                    }
                    if (entry.window.isDestroyed()) {
                        console.error('Viewer window teardown failed after it closed', error);
                        settle({ type: 'closed' });
                        return;
                    }
                    settle({ type: 'failed', error });
                });
                return;
            }
            // Settled already by a synchronous `closed` or cancellation.
            if (settled) return;
            if (entry.window.isDestroyed()) {
                settle({ type: 'closed' });
                return;
            }
            // Dispatch is complete, so the event now carries every listener's
            // verdict. No event at all means `close` never dispatched, which is not
            // a window on its way out — refused, rather than waited on forever.
            if (dispatched !== undefined && !dispatched.defaultPrevented) {
                return; // Closing asynchronously; `on_closed` settles it.
            }
            settle({ type: 'refused' });
        });
    }

    private start_lifecycle(
        entry: ViewerWindow,
        intent: 'reload' | 'close',
        ignore_cache = false,
    ): Promise<boolean> {
        const lifecycle = {
            intent,
            ignoreCache: ignore_cache,
            promise: Promise.resolve(false),
        } satisfies NonNullable<ViewerWindow['lifecycle']>;
        entry.lifecycle = lifecycle;
        lifecycle.promise = this.fence_renderer(entry)
            .then(() => {
                if (entry.window.isDestroyed()) return true;
                if (lifecycle.intent === 'close') return this.close_fenced_window(entry);
                if (lifecycle.ignoreCache) entry.window.webContents.reloadIgnoringCache();
                else entry.window.webContents.reload();
                return true;
            })
            .catch(() => {
                if (!entry.window.isDestroyed()) {
                    const closing = lifecycle.intent === 'close';
                    void dialog.showMessageBox(entry.window, {
                        type: 'error',
                        message: closing
                            ? 'Table Viewer could not safely close this window.'
                            : 'Table Viewer could not safely reload this window.',
                        detail: closing
                            ? 'The latest edits have not been acknowledged by the current state backend. The window will remain open so you can retry.'
                            : 'The current state backend has not acknowledged the latest edits. The window was not reloaded so you can retry.',
                        buttons: ['OK'],
                        noLink: true,
                    });
                }
                return false;
            })
            .finally(() => {
                if (entry.lifecycle === lifecycle) entry.lifecycle = undefined;
            });
        return lifecycle.promise;
    }

    private close_entry(entry: ViewerWindow): Promise<boolean> {
        if (entry.window.isDestroyed()) return Promise.resolve(true);
        if (entry.lifecycle) {
            // A native close or application quit claims a pending reload's single
            // fence. Its flush continues, but completion closes instead of
            // navigating, so there is never a second concurrent renderer flush.
            entry.lifecycle.intent = 'close';
            return entry.lifecycle.promise.then((settled) => {
                if (entry.window.isDestroyed()) return true;
                // The reload branch may have observed its intent just before this
                // close claimed it. Only a destroyed window proves the claim won;
                // after a successful reload, start one fresh serialized close fence.
                return settled ? this.close_entry(entry) : false;
            });
        }
        return this.start_lifecycle(entry, 'close');
    }

    private bounds_for_new_window() {
        // A drag still inside its settle window has not been persisted yet, and
        // a file can be opened at any moment — from Finder, or a second launch.
        // Without this the new window would ignore a resize the user has
        // already finished making.
        this.flush_pending_sizes();
        const settings = this.config_store.settings();
        const previous = this.windows
            .map((entry) => entry.window)
            .filter((window) => !window.isDestroyed())
            .pop();
        const previous_bounds = previous?.getNormalBounds() ?? null;
        const work_area = (previous_bounds
            ? screen.getDisplayMatching(previous_bounds)
            : screen.getPrimaryDisplay()
        ).workArea;
        // The stored pair, never `previous_bounds`: `previous` is the most
        // recently *created* window, which is not the most recently *resized*
        // one. Sizing from it would contradict both what is tracked and what
        // Preferences shows the moment the user resizes any other window.
        // `previous_bounds` is for the cascade placement only.
        return next_window_bounds(
            work_area,
            { width: settings.windowWidth, height: settings.windowHeight },
            previous_bounds,
        );
    }

    /** Persist every resize still inside its settle window. Order does not
     *  matter: each carries the sequence `store_size` ranks it by. */
    private flush_pending_sizes(): void {
        for (const entry of this.windows) entry.flush_size();
    }

    /**
     * Adopt the size of the window the user last resized as the tracked one.
     *
     * For the switch into `match-last`: until that moment resizes were
     * deliberately ignored, so the stored pair is whatever was last typed under
     * `fixed` rather than any window's size, and without this the first window
     * opened afterwards would still use it.
     */
    adopt_current_size(): void {
        // First, so this reads a window whose pending drag has been accounted
        // for rather than racing it.
        this.flush_pending_sizes();
        const live = this.windows.filter((entry) => !entry.window.isDestroyed());
        if (live.length === 0) return;
        // Highest `resize_seq` wins; ties (no window resized yet, all still 0)
        // fall to the most recently created, which is the best guess available.
        const target = live.reduce(
            (best, entry) => (entry.resize_seq >= best.resize_seq ? entry : best),
        );
        // getNormalBounds, so a window that is minimized or maximized right now
        // still contributes its real size — this is a one-shot with no later
        // event behind it. Safe here, unlike on the resize path: the focused
        // window is Preferences, not a viewer holding an open cell editor.
        //
        // A fresh sequence: the user asking for this mode is the newest word on
        // the subject, and outranks any resize still in flight.
        this.store_size(target.window.getNormalBounds(), ++this.resize_counter);
    }

    /**
     * Record `size` as what a new window should open at — the `match-last` half
     * of the new-window-size preference.
     *
     * Takes a size rather than a window because its callers measure at
     * different moments: the resize path samples during the drag and hands the
     * value over the debounce, so that a maximize or minimize before the timer
     * fires cannot make the size the user just chose unreadable.
     *
     * `seq` is which resize it came from, and the last one recorded wins
     * regardless of arrival order. Debounced writes from different windows are
     * genuinely concurrent — closing the window resized second flushes only its
     * own pending write, leaving the first window's older one to land after —
     * so recency has to be carried with the value rather than inferred from
     * when it shows up.
     */
    private store_size({ width, height }: WindowSize, seq: number): void {
        if (seq < this.last_stored_seq) return;
        this.last_stored_seq = seq;
        const settings = this.config_store.settings();
        // Under `fixed` the stored size is the user's typed preference, so
        // dragging a window must not quietly overwrite it.
        if (settings.newWindowSize === 'fixed') return;
        if (settings.windowWidth === width && settings.windowHeight === height) return;
        try {
            this.config_store.update({ windowWidth: width, windowHeight: height });
        } catch (error) {
            // Best-effort convenience: one caller is the window's 'close'
            // handler, where an unwritable userData directory would otherwise
            // take down the whole app on the way out.
            console.error('Failed to remember the window size', error);
        }
    }

    private teardown(entry: ViewerWindow): void {
        const index = this.windows.indexOf(entry);
        if (index >= 0) this.windows.splice(index, 1);
        entry.stop_watching_dirty();
        entry.stop_watching_renderer();
        try {
            entry.controller.dispose();
        } catch {
            // Never let one window's teardown failure leak into the others.
        }
        entry.panel.dispose();
    }

    private viewer_host(window: BrowserWindow): ViewerHost {
        // Dialogs are sheeted on the window whose file they are about.
        const message_box = (
            options: Electron.MessageBoxOptions,
        ): Promise<Electron.MessageBoxReturnValue> => (
            window.isDestroyed()
                ? dialog.showMessageBox(options)
                : dialog.showMessageBox(window, options)
        );
        return {
            fs: node_file_system_port,
            ui: create_desktop_ui_port({
                show_warning: (message) => {
                    void message_box({ type: 'warning', message });
                },
                show_error: (message) => {
                    void message_box({ type: 'error', message });
                },
                show_save_discard_dialog: async () => {
                    const { response } = await message_box({
                        type: 'warning',
                        message: 'You have unsaved changes.',
                        buttons: ['Save', 'Discard', 'Cancel'],
                        defaultId: 0,
                        cancelId: 2,
                        noLink: true,
                    });
                    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
                },
            }),
            config: this.config_store.config_port(),
            refreshWatcherFactory: node_file_refresh_watcher_factory,
        };
    }
}
