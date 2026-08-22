// One global startup/shutdown gate for the desktop main process.
//
// Electron delivers `open-file`, `second-instance`, and `activate` before the
// app has a state backend: macOS fires `open-file` for a double-clicked
// document *before* `ready`, and a second launch can hand us paths while the
// first instance is still opening SQLite. Running that work early would either
// drop the request or make a window whose controller has no store to read from,
// so requests that arrive during startup are buffered and released once — and
// only once — the backend is actually usable.
//
// The same gate closes the other end. Once shutdown begins, no new controller
// or window work may be admitted: a window created after the drain started
// would outlive the store it depends on and would keep the app alive past the
// point where its state can be persisted. "Once shutdown begins" means the
// *first* `before-quit`, not the moment the connection closes — the window-close
// fence runs in between, and a window admitted during it is never fenced, so it
// survives the drain holding a controller over a closed connection and then
// vetoes every subsequent quit.
//
// Because a viewer may veto its close and leave the app running, that refusal is
// reversible: `abandon_drain` restores the phase the barrier interrupted so the
// user is not left with an app that has stopped opening files. It is the only
// way back, it never resurrects a `failed` phase, and it never restores the work
// the drain already dropped.
//
// Pure module (no electron import) so it is unit-testable; main.ts owns the
// wiring from real Electron events to `submit`.
//
// `create_desktop_state_backend` below is the same gate seen from the store's
// side: which connection is published, and whether it has been closed. It lives
// here rather than in main.ts precisely because the orderings it exists to
// prevent (a quit that lands mid-open, a close that fails) are unreachable from
// a test that cannot drive Electron.

export type DesktopLifecyclePhase = 'starting' | 'ready' | 'draining' | 'failed';

export interface DesktopLifecycle {
    readonly phase: DesktopLifecyclePhase;
    /** Run `work` now if ready, buffer it if starting, drop it once terminal. */
    submit(work: () => void): void;
    /** Backend is usable: flush the buffer in submission order and stay ready. */
    become_ready(): void;
    /** Backend is unusable: drop the buffer permanently and refuse new work. */
    become_failed(): void;
    /**
     * Begin shutdown. True for the first caller of a barrier, so the drain runs
     * once; false while that barrier is still standing.
     *
     * Not "true exactly once for the lifetime of the process" any more: a viewer
     * that vetoes its close leaves the app running, and `abandon_drain` puts the
     * gate back the way it was, after which a later quit is a genuinely new
     * barrier and gets `true` again. What is still exactly-once is the thing that
     * mattered — for any one barrier, only one caller drains.
     */
    begin_drain(): boolean;
    /**
     * Undo a drain that will not complete, restoring the phase it interrupted.
     *
     * The one path back from `draining`, and only for a quit that was refused
     * before the connection closed: a vetoed window close. It restores
     * *admission*, never data — the work the drain dropped stays dropped, since
     * nothing buffered it after the phase changed.
     *
     * A no-op unless the phase is still `draining`, so it can never resurrect a
     * `failed` backend or reopen a drain that already closed the store.
     */
    abandon_drain(): void;
}

export function create_desktop_lifecycle(): DesktopLifecycle {
    let phase: DesktopLifecyclePhase = 'starting';
    let buffered: Array<() => void> = [];
    /** The phase `begin_drain` displaced, so `abandon_drain` can put it back
     *  rather than guessing `ready` — a Cmd-Q during startup interrupts
     *  `starting`, and restoring `ready` there would run work against a backend
     *  that has not been published yet. */
    let interrupted: DesktopLifecyclePhase | undefined;

    const discard = (): void => {
        // Dropped rather than run: the work assumed a backend that either never
        // arrived (`failed`) or is going away (`draining`).
        buffered = [];
    };

    return {
        get phase(): DesktopLifecyclePhase {
            return phase;
        },
        submit(work: () => void): void {
            if (phase === 'ready') {
                work();
                return;
            }
            if (phase === 'starting') buffered.push(work);
            // `draining` / `failed` deliberately drop the request. There is no
            // later phase that could run it, so buffering it would only leak.
        },
        become_ready(): void {
            // No resurrection: a backend that reports ready after a drain or a
            // failure has already lost its callers' assumptions. Discard rather
            // than run, so a late `ready` cannot open windows during shutdown.
            if (phase === 'draining' || phase === 'failed') {
                discard();
                return;
            }
            phase = 'ready';
            const pending = buffered;
            buffered = [];
            for (const work of pending) {
                // Rechecked every iteration, not once before the loop. A
                // buffered request is arbitrary app work — opening a file can
                // discover the backend is unusable and call `become_failed`, and
                // a Cmd-Q handled inside one can call `begin_drain` — so the
                // phase can change *during* the flush. Without this, the
                // remaining items ran against a backend that was already dead or
                // draining, which is the exact thing `submit` refuses to admit
                // one line above. Dropped rather than re-buffered, matching
                // `discard()`: neither terminal phase has a later flush that
                // could run them.
                if (phase !== 'ready') return;
                try {
                    work();
                } catch {
                    // Each buffered request is an independent user intent — one
                    // file that fails to open must not swallow the other files
                    // from the same launch. The caller of `submit` is
                    // responsible for reporting its own failure; the flush only
                    // guarantees that every request gets its turn.
                }
            }
        },
        become_failed(): void {
            phase = 'failed';
            // Terminal, so there is nothing left to restore: a later
            // `abandon_drain` must not walk back out of `failed`.
            interrupted = undefined;
            discard();
        },
        begin_drain(): boolean {
            if (phase === 'draining') return false;
            interrupted = phase;
            phase = 'draining';
            discard();
            return true;
        },
        abandon_drain(): void {
            // Guarded on the current phase, not on `interrupted` alone: a
            // `become_failed` that arrived during the barrier is the app's final
            // word, and restoring over it would admit work into a backend that
            // never opened.
            if (phase !== 'draining') return;
            phase = interrupted ?? 'starting';
            interrupted = undefined;
        },
    };
}

// --- window-request routing -------------------------------------------------
//
// What each window-creating request *means*, separated from Electron so it is
// testable. main.ts owns the events and the BrowserWindows; the decision of
// whether a given request makes a launcher, opens files, or is dropped lives
// here, because that decision is where the second-launch and dock-activation
// bugs live and main.ts cannot be loaded by a test.

/** A request that could produce a window, named after the Electron event or
 *  menu command it comes from — the source matters, because the same "no files"
 *  request means "make a launcher" from a second launch and "do nothing" from a
 *  dock click that already has a window. */
export type DesktopWindowRequest =
    /** `open-file` (Finder double-click, dock drop, `open`), or File → Open. */
    | { readonly kind: 'open-files'; readonly files: readonly string[] }
    /** A second launch of the app. Its argv files, already filtered. */
    | { readonly kind: 'second-instance'; readonly files: readonly string[] }
    /** macOS dock click. */
    | { readonly kind: 'activate' }
    /** This launch's own argv, replayed once the backend is open. */
    | { readonly kind: 'startup'; readonly files: readonly string[] }
    /** File → New Window. */
    | { readonly kind: 'new-window' }
    /** File → Compare Files…, once the dialog has both paths. */
    | {
        readonly kind: 'compare-files';
        readonly originalPath: string;
        readonly modifiedPath: string;
    };

/** What is on screen at the moment a request is routed. Launchers count as
 *  document windows for `activate`; Preferences and About deliberately do not —
 *  they are utility windows, so activating with only one of them open should
 *  still produce something to work in. */
export interface DesktopWindowState {
    readonly hasViewerWindow: boolean;
    readonly hasLauncherWindow: boolean;
}

export type DesktopWindowAction =
    | { readonly kind: 'open-files'; readonly files: readonly string[] }
    | { readonly kind: 'show-launcher'; readonly focus: boolean }
    | {
        readonly kind: 'compare-files';
        readonly originalPath: string;
        readonly modifiedPath: string;
    }
    /** The request is satisfied by what is already on screen. Note that being
     *  *dropped* for phase reasons is not this: that is the lifecycle gate's
     *  job, and the router is never reached at all in that case. */
    | { readonly kind: 'none' };

/**
 * Decide what one window request does, given what is already on screen.
 *
 * Pure, and deliberately says nothing about lifecycle phase: the phase question
 * ("may this run at all, or must it be buffered or dropped?") is answered once,
 * by `submit`, and answering it twice in two places is how the two answers drift
 * apart. Every caller in main.ts routes from inside `lifecycle.submit`, so a
 * request reaching here has already been admitted.
 */
export function route_desktop_window_request(
    request: DesktopWindowRequest,
    state: DesktopWindowState,
): DesktopWindowAction {
    const has_document_window = state.hasViewerWindow || state.hasLauncherWindow;
    switch (request.kind) {
        case 'open-files':
            // Nothing supported to show is not a reason to conjure a launcher:
            // the user asked for a specific file, not for the app.
            return request.files.length > 0
                ? { kind: 'open-files', files: request.files }
                : { kind: 'none' };
        case 'second-instance':
            // A second launch with no file behaves like File → New Window, and
            // focuses: the user just asked for this app from outside it.
            return request.files.length > 0
                ? { kind: 'open-files', files: request.files }
                : { kind: 'show-launcher', focus: true };
        case 'activate':
            // The dock-clicking user wants somewhere to work; if they already
            // have one, they wanted the app forward, which the OS did itself.
            return has_document_window ? { kind: 'none' } : { kind: 'show-launcher', focus: false };
        case 'startup':
            if (request.files.length > 0) return { kind: 'open-files', files: request.files };
            // A launcher only when nothing else has produced a window — a
            // buffered `open-file` from a Finder double-click, released moments
            // ago by the same flush, counts.
            return has_document_window ? { kind: 'none' } : { kind: 'show-launcher', focus: false };
        case 'new-window':
            // Always a new one: several launchers may be open at once, and the
            // command's whole purpose is to add one.
            return { kind: 'show-launcher', focus: false };
        case 'compare-files':
            // Unconditional: the user named two specific files, so what is
            // already on screen has no bearing on it.
            return {
                kind: 'compare-files',
                originalPath: request.originalPath,
                modifiedPath: request.modifiedPath,
            };
    }
}

/**
 * Whether the launcher window a file-open request came from steps aside.
 *
 * Only when a viewer window actually appeared. During the quit drain
 * `open_file` refuses every file, and closing the launcher then would leave the
 * user with nothing on screen and no way back — so "the request was made" is not
 * the condition; "a window exists to replace it" is.
 */
export function launcher_steps_aside(
    opened_any: boolean,
    source_is_launcher: boolean,
): boolean {
    return opened_any && source_is_launcher;
}

/** The one thing this module needs of a state backend: it can be closed. */
export interface ClosableStateBackend {
    close(): Promise<void>;
}

/**
 * How a drain ended.
 *
 * A value rather than a rejection because the two endings need *different*
 * handling and a rejection cannot express that difference: `closed` means the
 * connection is released and quitting is safe, while `close-failed` means the
 * close ran and did not succeed — and, crucially, cannot be run again.
 *
 * `OpenedSqliteFileStateStore.close` memoizes its own promise permanently (see
 * `closePromise` in src/sqlite-file-state-persistence.ts, mirrored in
 * src/sqlite-runtime.ts), so a second call returns the same already-rejected
 * promise without re-attempting anything. A "retry" of a failed close is
 * therefore fiction, and treating one as retryable is what left the app
 * permanently unquittable: the barrier kept `allow_quit` false, every later
 * Cmd-Q re-entered a barrier that could only fail the same way, and force-quit
 * was the only exit — over a connection that had already been closed.
 */
export type DesktopDrainOutcome =
    | { readonly type: 'closed' }
    /** Terminal. Refusing to quit does not improve durability here, since the
     *  close attempt already ran and cannot be re-run; the caller reports it and
     *  lets the quit proceed. */
    | { readonly type: 'close-failed' };

export interface DesktopStateBackend<TStore extends ClosableStateBackend> {
    /** The store the app may use, or undefined before publication and after a
     *  completed drain. */
    readonly published: TStore | undefined;
    /** Whether shutdown has begun, so a caller can refuse to make a window. */
    readonly draining: boolean;
    /**
     * Hand a freshly opened store to the app.
     *
     * False means shutdown began while the open was still in flight: the store
     * has been closed instead of published, and the caller must create no window
     * and treat the launch as over. Rejects only if that close failed.
     */
    publish(store: TStore): Promise<boolean>;
    /**
     * Refuse all new controller and window work, from here on.
     *
     * Called on entry to the quit barrier, *before* the window-close fence — not
     * after it. The fence is asynchronous and the OS keeps delivering `open-file`
     * throughout it; a window admitted in that gap is not in the fence's
     * snapshotted list, so it is never fenced, survives the drain holding a
     * controller over a closed connection, and then vetoes every later quit.
     */
    begin_shutdown(): void;
    /**
     * Take that refusal back, because the quit will not happen after all.
     *
     * For a barrier that ended before the connection closed — a vetoed window
     * close, or a close fence that rejected. The app is staying up, so an app that
     * has silently stopped opening files would be a worse outcome than the quit
     * the user cancelled.
     *
     * A no-op once `drain` has attempted a close, whatever the outcome. That is
     * enforced here rather than assumed of the caller: the connection is gone or
     * in whatever state a failed close left it, so re-admitting would attach a
     * controller to it and release buffered `open-file` work over it.
     */
    abandon_shutdown(): void;
    /**
     * Close the published store as part of shutdown.
     *
     * Never rejects: the outcome is the return value, because a failed close is
     * terminal rather than retryable (see `DesktopDrainOutcome`). Concurrent
     * calls share the one in-flight close, and a call after a `close-failed`
     * answers `close-failed` again without re-awaiting the memoized rejection.
     */
    drain(): Promise<DesktopDrainOutcome>;
}

/**
 * The published-store half of the lifecycle, kept here rather than in main.ts so
 * it can be tested without Electron.
 *
 * It exists because three orderings are otherwise unsafe. A Cmd-Q during startup
 * drains before the open finishes, so a store published afterwards would never
 * be closed — stranding its writer-session row and leases and possibly leaving a
 * hot journal for the next launch. Admission has to stop at the *start* of the
 * quit barrier rather than after the window-close fence, or a window created
 * during the fence escapes it entirely. And a close that *fails* has to be
 * reported as its own terminal outcome, because the underlying close memoizes
 * its rejection and cannot be re-attempted — so pretending it is retryable
 * leaves the app unquittable rather than more durable.
 */
export function create_desktop_state_backend<TStore extends ClosableStateBackend>(
    lifecycle: Pick<DesktopLifecycle, 'begin_drain' | 'abandon_drain'>,
    stop_admission: () => void,
    resume_admission: () => void = () => {},
): DesktopStateBackend<TStore> {
    let published: TStore | undefined;
    let draining = false;
    /** The single close in flight, so two quit paths cannot race one teardown. */
    let closing: Promise<DesktopDrainOutcome> | undefined;
    /** Latched once a close ran and failed. The underlying close memoizes its
     *  rejection, so this is the honest answer for every later caller: there is
     *  nothing left to attempt. */
    let close_failed = false;
    /** Latched the instant a close is attempted — the point of no return. Past it
     *  the connection is either released or in whatever state a failed close left
     *  it, so `abandon_shutdown` must not put admission back. The barrier is shaped
     *  so it should never ask, but "should never" is an assumption, and the two
     *  statements that run after the close (`report_close_failure`, which is a
     *  console.error and throws on EPIPE, and `resume_quit`, which is app.quit())
     *  are exactly the kind of thing that turns an assumption into a resurrected
     *  store. Enforced here so the invariant holds for any caller. */
    let close_attempted = false;

    /** Phase first (so no buffered startup work is released into a closing
     *  backend), then admission (so no new viewer can attach a controller).
     *  Both idempotent, so re-asserting is free. */
    const enter_shutdown = (): void => {
        draining = true;
        lifecycle.begin_drain();
        stop_admission();
    };

    return {
        get published(): TStore | undefined {
            return published;
        },
        get draining(): boolean {
            return draining;
        },
        async publish(store: TStore): Promise<boolean> {
            // Never published into a shutdown: whoever asked for this store is
            // gone, and a window attached to it would outlive the drain.
            if (draining) {
                await store.close();
                return false;
            }
            published = store;
            return true;
        },
        begin_shutdown(): void {
            enter_shutdown();
        },
        abandon_shutdown(): void {
            // Past the point of no return this is a no-op rather than a mirror:
            // once a close has been attempted there is no un-closed connection to
            // go back to, and re-admitting would let `open_file` attach a
            // controller to a released store and let the phase change release
            // buffered `open-file` work over it. Deliberately not conditioned on
            // `published` alone — a *failed* close leaves it set on purpose (so a
            // caller can see which connection it was), and that store is no more
            // usable than a cleared one.
            if (close_attempted) return;
            // Ordered as the mirror of `enter_shutdown`: admission back first, then
            // the phase, so no request can be released by the phase change into a
            // manager that is still refusing.
            draining = false;
            resume_admission();
            lifecycle.abandon_drain();
        },
        drain(): Promise<DesktopDrainOutcome> {
            enter_shutdown();
            // Answered without re-awaiting the memoized rejection: the close
            // already ran, and `store.close()` would hand back the same settled
            // failure rather than retrying anything.
            if (close_failed) return Promise.resolve({ type: 'close-failed' as const });
            if (closing) return closing;
            const store = published;
            if (!store) return Promise.resolve({ type: 'closed' as const });
            // Latched before the call, not in its continuations: the close is in
            // flight from this line on, and an `abandon_shutdown` arriving during it
            // is already too late to have an un-closed connection to restore.
            close_attempted = true;
            // `published` is cleared only on success, so a caller inspecting it
            // after a failure still sees which connection was left in whatever
            // state the failed close left it.
            closing = store.close().then((): DesktopDrainOutcome => {
                published = undefined;
                return { type: 'closed' };
            }, (): DesktopDrainOutcome => {
                close_failed = true;
                return { type: 'close-failed' };
            }).finally(() => {
                closing = undefined;
            });
            return closing;
        },
    };
}
