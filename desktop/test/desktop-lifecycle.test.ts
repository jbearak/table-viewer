import { describe, expect, it, vi } from 'vitest';
import {
    create_desktop_lifecycle,
    create_desktop_state_backend,
    launcher_steps_aside,
    route_desktop_window_request,
    type DesktopWindowAction,
    type DesktopWindowRequest,
    type DesktopWindowState,
} from '../main/desktop-lifecycle';

/** A store that records its closes and can be made to fail them, standing in for
 *  the real SQLite connection main.ts publishes. */
function fake_store() {
    let fail_next = false;
    const closes: number[] = [];
    return {
        closes,
        fail_next_close(): void {
            fail_next = true;
        },
        async close(): Promise<void> {
            closes.push(closes.length + 1);
            if (fail_next) {
                fail_next = false;
                throw new Error('close failed');
            }
        },
    };
}

describe('desktop lifecycle gate', () => {
    it('buffers work submitted while starting and releases it once, in order', () => {
        const lifecycle = create_desktop_lifecycle();
        const ran: string[] = [];
        expect(lifecycle.phase).toBe('starting');
        lifecycle.submit(() => ran.push('first'));
        lifecycle.submit(() => ran.push('second'));
        lifecycle.submit(() => ran.push('third'));
        expect(ran).toEqual([]);

        lifecycle.become_ready();
        expect(lifecycle.phase).toBe('ready');
        expect(ran).toEqual(['first', 'second', 'third']);

        // A second ready must not replay the buffer it already flushed.
        lifecycle.become_ready();
        expect(ran).toEqual(['first', 'second', 'third']);
    });

    it('runs work submitted after becoming ready immediately', () => {
        const lifecycle = create_desktop_lifecycle();
        lifecycle.become_ready();
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('now'));
        expect(ran).toEqual(['now']);
    });

    it('discards buffered work on failure, including across a later ready', () => {
        const lifecycle = create_desktop_lifecycle();
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('buffered'));

        lifecycle.become_failed();
        expect(lifecycle.phase).toBe('failed');
        expect(ran).toEqual([]);

        lifecycle.submit(() => ran.push('after-failure'));
        lifecycle.become_ready();
        expect(lifecycle.phase).toBe('failed');
        expect(ran).toEqual([]);
    });

    it('admits exactly one drain per barrier and no work once draining', () => {
        const lifecycle = create_desktop_lifecycle();
        lifecycle.become_ready();
        expect(lifecycle.begin_drain()).toBe(true);
        expect(lifecycle.phase).toBe('draining');
        expect(lifecycle.begin_drain()).toBe(false);
        expect(lifecycle.begin_drain()).toBe(false);

        const ran: string[] = [];
        lifecycle.submit(() => ran.push('during-drain'));
        expect(ran).toEqual([]);
    });

    it('restores the phase the drain interrupted when the quit is abandoned', () => {
        // A viewer can veto its close, which leaves the app running. Leaving the
        // gate closed there gives the user an app that silently ignores every
        // Finder double-click, with no message and no way back short of the quit
        // they just declined.
        const lifecycle = create_desktop_lifecycle();
        lifecycle.become_ready();
        expect(lifecycle.begin_drain()).toBe(true);

        lifecycle.abandon_drain();

        expect(lifecycle.phase).toBe('ready');
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('after-veto'));
        expect(ran).toEqual(['after-veto']);
        // A genuinely new barrier, so the next quit drains once again.
        expect(lifecycle.begin_drain()).toBe(true);
        expect(lifecycle.begin_drain()).toBe(false);
    });

    it('restores starting, not ready, for a quit abandoned during startup', () => {
        // Cmd-Q while SQLite is still opening interrupts `starting`. Restoring
        // `ready` would run buffered work against a store that has not been
        // published yet.
        const lifecycle = create_desktop_lifecycle();
        expect(lifecycle.begin_drain()).toBe(true);

        lifecycle.abandon_drain();

        expect(lifecycle.phase).toBe('starting');
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('buffered-again'));
        expect(ran).toEqual([]);
        lifecycle.become_ready();
        expect(ran).toEqual(['buffered-again']);
    });

    it('never restores work the drain already dropped, and never leaves failed', () => {
        const lifecycle = create_desktop_lifecycle();
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('dropped-by-drain'));
        expect(lifecycle.begin_drain()).toBe(true);

        lifecycle.abandon_drain();

        // Admission is back; the request that was dropped stays dropped.
        expect(lifecycle.phase).toBe('starting');
        lifecycle.become_ready();
        expect(ran).toEqual([]);

        // And a failure during the barrier is the app's final word: abandoning
        // must not walk back out of it into a backend that never opened.
        const failing = create_desktop_lifecycle();
        failing.become_ready();
        expect(failing.begin_drain()).toBe(true);
        failing.become_failed();
        failing.abandon_drain();
        expect(failing.phase).toBe('failed');
        failing.submit(() => ran.push('after-failure'));
        expect(ran).toEqual([]);
    });

    it('ignores an abandon that is not undoing a standing drain', () => {
        const lifecycle = create_desktop_lifecycle();
        lifecycle.abandon_drain();
        expect(lifecycle.phase).toBe('starting');
        lifecycle.become_ready();
        lifecycle.abandon_drain();
        expect(lifecycle.phase).toBe('ready');
    });

    it('does not resurrect buffered work when ready arrives after a drain', () => {
        const lifecycle = create_desktop_lifecycle();
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('buffered'));

        expect(lifecycle.begin_drain()).toBe(true);
        lifecycle.become_ready();
        expect(lifecycle.phase).toBe('draining');
        expect(ran).toEqual([]);
    });

    it('keeps flushing buffered work after one item throws', () => {
        const lifecycle = create_desktop_lifecycle();
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('before'));
        lifecycle.submit(() => {
            ran.push('throwing');
            throw new Error('one request failed');
        });
        lifecycle.submit(() => ran.push('after'));

        expect(() => lifecycle.become_ready()).not.toThrow();
        expect(ran).toEqual(['before', 'throwing', 'after']);
        expect(lifecycle.phase).toBe('ready');
    });
});

describe('desktop state backend', () => {
    it('publishes a store and closes it on the drain', async () => {
        const lifecycle = create_desktop_lifecycle();
        const stop_admission = vi.fn();
        const backend = create_desktop_state_backend(lifecycle, stop_admission);
        const store = fake_store();

        await expect(backend.publish(store)).resolves.toBe(true);
        expect(backend.published).toBe(store);
        expect(store.closes).toEqual([]);

        await expect(backend.drain()).resolves.toEqual({ type: 'closed' });

        expect(store.closes).toEqual([1]);
        expect(backend.published).toBeUndefined();
        expect(lifecycle.phase).toBe('draining');
        expect(stop_admission).toHaveBeenCalled();
    });

    it('stops admission on entry to the barrier, before anything is closed', () => {
        // The window-close fence runs between this and the drain, and the OS keeps
        // delivering `open-file` throughout it. A window admitted in that gap is
        // not in the fence's snapshotted list, so it is never fenced.
        const lifecycle = create_desktop_lifecycle();
        const stop_admission = vi.fn();
        const backend = create_desktop_state_backend(lifecycle, stop_admission);

        backend.begin_shutdown();

        expect(stop_admission).toHaveBeenCalledOnce();
        expect(backend.draining).toBe(true);
        expect(lifecycle.phase).toBe('draining');
    });

    it('takes the refusal back, connection untouched, when the quit is abandoned', async () => {
        const lifecycle = create_desktop_lifecycle();
        const stop_admission = vi.fn();
        const resume_admission = vi.fn();
        const backend = create_desktop_state_backend(
            lifecycle,
            stop_admission,
            resume_admission,
        );
        const store = fake_store();
        await backend.publish(store);
        lifecycle.become_ready();

        backend.begin_shutdown();
        backend.abandon_shutdown();

        expect(resume_admission).toHaveBeenCalledOnce();
        expect(backend.draining).toBe(false);
        expect(lifecycle.phase).toBe('ready');
        // Reached only before the connection closed, so there is nothing
        // half-closed to reason about — and the store is still the app's.
        expect(store.closes).toEqual([]);
        expect(backend.published).toBe(store);

        // A later quit still works, and closes exactly once.
        await expect(backend.drain()).resolves.toEqual({ type: 'closed' });
        expect(store.closes).toEqual([1]);
    });

    it('refuses to take the refusal back once a close has been attempted', async () => {
        // The invariant the doc comment used to only assert. Everything the quit
        // barrier does after the drain — reporting a failed close (a console.error,
        // which throws on EPIPE) and calling app.quit() — runs with the connection
        // already released, and a throw from either used to route back here. There
        // is no un-closed connection left to restore at that point, so re-admitting
        // would attach a controller to a released store and release buffered
        // `open-file` work over it.
        const lifecycle = create_desktop_lifecycle();
        const resume_admission = vi.fn();
        const backend = create_desktop_state_backend(
            lifecycle,
            () => {},
            resume_admission,
        );
        const store = fake_store();
        await backend.publish(store);
        lifecycle.become_ready();

        await expect(backend.drain()).resolves.toEqual({ type: 'closed' });
        backend.abandon_shutdown();

        expect(resume_admission).not.toHaveBeenCalled();
        expect(backend.draining).toBe(true);
        expect(lifecycle.phase).toBe('draining');
        const ran: string[] = [];
        lifecycle.submit(() => ran.push('after-close'));
        expect(ran).toEqual([]);
    });

    it('refuses it after a failed close too, published store notwithstanding', async () => {
        // A failed close deliberately leaves `published` set, so a caller can still
        // see which connection it was for — which is exactly why the guard cannot be
        // "published is undefined". That store is no more usable than a cleared one:
        // the close already ran and the underlying close memoizes its rejection.
        const lifecycle = create_desktop_lifecycle();
        const resume_admission = vi.fn();
        const backend = create_desktop_state_backend(
            lifecycle,
            () => {},
            resume_admission,
        );
        const store = fake_store();
        await backend.publish(store);
        lifecycle.become_ready();
        store.fail_next_close();

        await expect(backend.drain()).resolves.toEqual({ type: 'close-failed' });
        backend.abandon_shutdown();

        expect(resume_admission).not.toHaveBeenCalled();
        expect(backend.published).toBe(store);
        expect(backend.draining).toBe(true);
        expect(lifecycle.phase).toBe('draining');
    });

    it('refuses it while a close is still in flight', async () => {
        // Latched at the call, not in its continuations: from the moment
        // `store.close()` is entered there is no un-closed connection to go back to,
        // so an abandon racing the close is already too late.
        const lifecycle = create_desktop_lifecycle();
        const resume_admission = vi.fn();
        const backend = create_desktop_state_backend(
            lifecycle,
            () => {},
            resume_admission,
        );
        let release!: () => void;
        const closing = new Promise<void>((done) => { release = done; });
        const store = { close: (): Promise<void> => closing };
        await backend.publish(store);
        lifecycle.become_ready();

        const drained = backend.drain();
        backend.abandon_shutdown();

        expect(resume_admission).not.toHaveBeenCalled();
        expect(backend.draining).toBe(true);
        expect(lifecycle.phase).toBe('draining');

        release();
        await expect(drained).resolves.toEqual({ type: 'closed' });
    });

    it('closes rather than publishes a store that finishes opening after a drain', async () => {
        // Cmd-Q during startup: the drain runs while the open is still in
        // flight, so it closes nothing. Publishing afterwards would strand the
        // writer-session row and its leases, and possibly a hot journal, with
        // nothing left that would ever close the connection.
        const lifecycle = create_desktop_lifecycle();
        const backend = create_desktop_state_backend(lifecycle, () => {});
        await backend.drain();
        const late = fake_store();

        await expect(backend.publish(late)).resolves.toBe(false);

        expect(late.closes).toEqual([1]);
        expect(backend.published).toBeUndefined();
        expect(backend.draining).toBe(true);
    });

    it('reports a failed publish-time close rather than swallowing it', async () => {
        const lifecycle = create_desktop_lifecycle();
        const backend = create_desktop_state_backend(lifecycle, () => {});
        await backend.drain();
        const late = fake_store();
        late.fail_next_close();

        await expect(backend.publish(late)).rejects.toThrow('close failed');
        // Still not published: a store nobody can use must not become the one the
        // app reads through.
        expect(backend.published).toBeUndefined();
    });

    it('answers a failed close as a terminal outcome, never as a rejection', async () => {
        // The underlying close memoizes its own promise permanently (see
        // `closePromise` in sqlite-file-state-persistence.ts, mirrored in
        // sqlite-runtime.ts), so a second call hands back the same settled
        // rejection without re-attempting anything. A "retry" is therefore
        // fiction, and the old contract that promised one is what left the app
        // unquittable: the barrier kept `allow_quit` false and every later Cmd-Q
        // re-entered a barrier that could only fail identically.
        const lifecycle = create_desktop_lifecycle();
        const backend = create_desktop_state_backend(lifecycle, () => {});
        const store = fake_store();
        await backend.publish(store);
        store.fail_next_close();

        await expect(backend.drain()).resolves.toEqual({ type: 'close-failed' });
        expect(store.closes).toEqual([1]);
        // Left in place, so a caller can still see which connection the failed
        // close was for. What is *not* claimed is that closing it again would help.
        expect(backend.published).toBe(store);

        // No second attempt: the answer is the same terminal outcome, computed
        // without touching the store.
        await expect(backend.drain()).resolves.toEqual({ type: 'close-failed' });
        expect(store.closes).toEqual([1]);
    });

    it('shares one close between concurrent drains', async () => {
        const lifecycle = create_desktop_lifecycle();
        const backend = create_desktop_state_backend(lifecycle, () => {});
        const store = fake_store();
        await backend.publish(store);

        const outcomes = await Promise.all([
            backend.drain(), backend.drain(), backend.drain(),
        ]);

        // Closing twice would race the first close's own teardown.
        expect(store.closes).toEqual([1]);
        expect(outcomes).toEqual([{ type: 'closed' }, { type: 'closed' }, { type: 'closed' }]);
    });

    it('drains harmlessly when no store was ever published', async () => {
        const lifecycle = create_desktop_lifecycle();
        const stop_admission = vi.fn();
        const backend = create_desktop_state_backend(lifecycle, stop_admission);

        await expect(backend.drain()).resolves.toEqual({ type: 'closed' });

        expect(lifecycle.phase).toBe('draining');
        expect(stop_admission).toHaveBeenCalled();
        expect(backend.published).toBeUndefined();
    });

    it('re-asserts the drain phase and admission stop on every barrier entry', async () => {
        // Both are idempotent on purpose: a second barrier — after an abandoned
        // quit, say — must re-close the same window/work admission it closed the
        // first time, even though `begin_drain` only answers true once per barrier.
        const lifecycle = create_desktop_lifecycle();
        const stop_admission = vi.fn();
        const resume_admission = vi.fn();
        const backend = create_desktop_state_backend(
            lifecycle,
            stop_admission,
            resume_admission,
        );
        const store = fake_store();
        await backend.publish(store);

        backend.begin_shutdown();
        expect(lifecycle.begin_drain()).toBe(false);
        backend.abandon_shutdown();

        await expect(backend.drain()).resolves.toEqual({ type: 'closed' });
        expect(stop_admission).toHaveBeenCalledTimes(2);
        expect(resume_admission).toHaveBeenCalledOnce();
        expect(backend.draining).toBe(true);
    });
});

const NOTHING_ON_SCREEN: DesktopWindowState = {
    hasViewerWindow: false,
    hasLauncherWindow: false,
};

describe('desktop window request routing', () => {
    it('opens the files a second launch brought, and launches when it brought none', () => {
        expect(route_desktop_window_request(
            { kind: 'second-instance', files: ['/tmp/a.csv', '/tmp/b.csv'] },
            NOTHING_ON_SCREEN,
        )).toEqual({ kind: 'open-files', files: ['/tmp/a.csv', '/tmp/b.csv'] });
        // A second launch with no file behaves like File → New Window, and focuses:
        // the user asked for this app from outside it.
        expect(route_desktop_window_request(
            { kind: 'second-instance', files: [] },
            NOTHING_ON_SCREEN,
        )).toEqual({ kind: 'show-launcher', focus: true });
        // And still focuses a fresh launcher even with windows already up — the
        // request came from outside the app, so something has to come forward.
        expect(route_desktop_window_request(
            { kind: 'second-instance', files: [] },
            { hasViewerWindow: true, hasLauncherWindow: true },
        )).toEqual({ kind: 'show-launcher', focus: true });
    });

    it('gives a dock activation somewhere to work only when there is nowhere', () => {
        expect(route_desktop_window_request({ kind: 'activate' }, NOTHING_ON_SCREEN))
            .toEqual({ kind: 'show-launcher', focus: false });
        // A launcher counts as somewhere to work; Preferences and About are not
        // tracked here at all, which is what makes "activating with only
        // Preferences open still produces a launcher" true by construction.
        expect(route_desktop_window_request(
            { kind: 'activate' },
            { hasViewerWindow: false, hasLauncherWindow: true },
        )).toEqual({ kind: 'none' });
        expect(route_desktop_window_request(
            { kind: 'activate' },
            { hasViewerWindow: true, hasLauncherWindow: false },
        )).toEqual({ kind: 'none' });
    });

    it('never conjures a launcher for a file request with nothing supported in it', () => {
        expect(route_desktop_window_request(
            { kind: 'open-files', files: [] },
            NOTHING_ON_SCREEN,
        )).toEqual({ kind: 'none' });
        expect(route_desktop_window_request(
            { kind: 'open-files', files: ['/tmp/a.csv'] },
            { hasViewerWindow: true, hasLauncherWindow: false },
        )).toEqual({ kind: 'open-files', files: ['/tmp/a.csv'] });
    });

    it('adds a launcher on startup only when nothing else produced a window', () => {
        expect(route_desktop_window_request(
            { kind: 'startup', files: ['/tmp/argv.csv'] },
            NOTHING_ON_SCREEN,
        )).toEqual({ kind: 'open-files', files: ['/tmp/argv.csv'] });
        expect(route_desktop_window_request({ kind: 'startup', files: [] }, NOTHING_ON_SCREEN))
            .toEqual({ kind: 'show-launcher', focus: false });
        // A buffered `open-file` from a Finder double-click, released by the same
        // flush moments earlier, is why this check exists: without it the user gets
        // their spreadsheet *and* an unwanted launcher behind it.
        expect(route_desktop_window_request(
            { kind: 'startup', files: [] },
            { hasViewerWindow: true, hasLauncherWindow: false },
        )).toEqual({ kind: 'none' });
        expect(route_desktop_window_request(
            { kind: 'startup', files: [] },
            { hasViewerWindow: false, hasLauncherWindow: true },
        )).toEqual({ kind: 'none' });
    });

    it('always adds a launcher for File → New Window', () => {
        // The one request whose whole purpose is to add one, so what is already on
        // screen must not suppress it.
        for (const state of [
            NOTHING_ON_SCREEN,
            { hasViewerWindow: true, hasLauncherWindow: false },
            { hasViewerWindow: false, hasLauncherWindow: true },
            { hasViewerWindow: true, hasLauncherWindow: true },
        ]) {
            expect(route_desktop_window_request({ kind: 'new-window' }, state))
                .toEqual({ kind: 'show-launcher', focus: false });
        }
    });

    // The wiring the router is half of. `submit` is the only thing that decides
    // whether a request runs at all; the router never sees a phase and so cannot
    // disagree with it.
    describe('through the lifecycle gate', () => {
        function routed_through(lifecycle: ReturnType<typeof create_desktop_lifecycle>) {
            const actions: DesktopWindowAction[] = [];
            // What main.ts's `submit_window_request` does, minus the electron.
            // The window state is sampled inside the buffered work, not at
            // submission, exactly as it is there.
            let state: DesktopWindowState = NOTHING_ON_SCREEN;
            return {
                actions,
                set_state(next: DesktopWindowState): void {
                    state = next;
                },
                submit(request: DesktopWindowRequest): void {
                    lifecycle.submit(() => {
                        actions.push(route_desktop_window_request(request, state));
                    });
                },
            };
        }

        it('replays a request that arrived while starting, once the backend is ready', () => {
            const lifecycle = create_desktop_lifecycle();
            const routing = routed_through(lifecycle);

            // macOS delivers `open-file` for a double-clicked document before
            // `ready`, and a second launch can arrive while SQLite is still opening.
            routing.submit({ kind: 'open-files', files: ['/tmp/double-clicked.csv'] });
            routing.submit({ kind: 'second-instance', files: [] });
            routing.submit({ kind: 'activate' });
            expect(routing.actions).toEqual([]);

            lifecycle.become_ready();

            expect(routing.actions).toEqual([
                { kind: 'open-files', files: ['/tmp/double-clicked.csv'] },
                { kind: 'show-launcher', focus: true },
                { kind: 'show-launcher', focus: false },
            ]);
        });

        it('reads the window state at replay time, not at submission time', () => {
            // Load-bearing for the startup ordering: the argv request is submitted
            // after the flush released a buffered `open-file`, and it must see the
            // window that flush produced.
            const lifecycle = create_desktop_lifecycle();
            const routing = routed_through(lifecycle);
            routing.submit({ kind: 'startup', files: [] });

            routing.set_state({ hasViewerWindow: true, hasLauncherWindow: false });
            lifecycle.become_ready();

            expect(routing.actions).toEqual([{ kind: 'none' }]);
        });

        it('drops a second launch or activation that arrives during the quit drain', () => {
            const lifecycle = create_desktop_lifecycle();
            const routing = routed_through(lifecycle);
            lifecycle.become_ready();
            expect(lifecycle.begin_drain()).toBe(true);

            // The OS keeps delivering these while the app is shutting down. A
            // launcher made now would outlive the store it depends on and keep the
            // app alive past the point where its state can be persisted.
            routing.submit({ kind: 'second-instance', files: [] });
            routing.submit({ kind: 'second-instance', files: ['/tmp/late.csv'] });
            routing.submit({ kind: 'activate' });
            routing.submit({ kind: 'open-files', files: ['/tmp/late.csv'] });
            routing.submit({ kind: 'new-window' });

            expect(routing.actions).toEqual([]);
            expect(lifecycle.phase).toBe('draining');
        });

        it('drops the same requests permanently after a failed start', () => {
            const lifecycle = create_desktop_lifecycle();
            const routing = routed_through(lifecycle);
            lifecycle.become_failed();

            routing.submit({ kind: 'second-instance', files: [] });
            routing.submit({ kind: 'activate' });
            // No resurrection: a late `ready` must not release them either.
            lifecycle.become_ready();

            expect(routing.actions).toEqual([]);
            expect(lifecycle.phase).toBe('failed');
        });
    });

    describe('launcher hand-off', () => {
        it('closes the launcher only when a viewer window actually opened', () => {
            expect(launcher_steps_aside(true, true)).toBe(true);
            // The drain case: `open_file` refused every file, so closing the
            // launcher would leave the user with nothing on screen and no way back.
            // This is the guard main.ts's `opened_any` bookkeeping exists to feed.
            expect(launcher_steps_aside(false, true)).toBe(false);
        });

        it('never closes a window the request did not come from a launcher', () => {
            // A viewer window that opens a file keeps its own file.
            expect(launcher_steps_aside(true, false)).toBe(false);
            expect(launcher_steps_aside(false, false)).toBe(false);
        });
    });
});
