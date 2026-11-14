import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { file_refresh_watch_identity } from '../file-refresh-watcher';
import { NodeFileRefreshWatcherFactory } from '../node-file-refresh-watcher';

/**
 * macOS delivers `fs.watch` events through FSEvents, which can report a change
 * seconds late or not at all. Under load the kernel drops events, and libuv
 * skips the "events were dropped" notice instead of passing it on. These tests
 * stand in a native watcher that reports only what each test fires by hand, so
 * a dropped event is deterministic rather than a matter of machine load.
 *
 * Writes a test counts events after are synchronous. An async write truncates
 * the file before it writes, and a poll landing between the two would report a
 * change of its own.
 */
type NativeListener = (event_type: string, filename: string | null) => void;

const native = vi.hoisted(() => ({
    listeners: [] as Array<(event_type: string, filename: string | null) => void>,
}));

vi.mock('fs', async (import_original) => {
    const actual = await import_original<typeof import('fs')>();
    const watch = (_directory: string, listener: NativeListener) => {
        native.listeners.push(listener);
        const watcher = new EventEmitter() as EventEmitter & { close(): void };
        watcher.close = () => {
            const index = native.listeners.indexOf(listener);
            if (index >= 0) native.listeners.splice(index, 1);
        };
        return watcher;
    };
    return { ...actual, default: { ...actual, watch }, watch };
});

const POLL_MS = 10;
const WAIT = { timeout: 5000, interval: 10 };

let temp_dir: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
    temp_dir = await fs.promises.realpath(
        await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-node-watch-lost-')),
    );
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    native.listeners.length = 0;
    await fs.promises.rm(temp_dir, { recursive: true, force: true });
});

function watch(file_path: string) {
    const watcher = new NodeFileRefreshWatcherFactory({ poll_interval_ms: POLL_MS })
        .create(file_refresh_watch_identity(file_path));
    cleanups.push(() => watcher.dispose());
    const events: string[] = [];
    watcher.on_event((kind) => events.push(kind));
    return events;
}

function fire_native(event_type: 'change' | 'rename', file_path: string): void {
    for (const listener of [...native.listeners]) {
        listener(event_type, path.basename(file_path));
    }
}

describe('Node file refresh watcher when the native watcher loses events', () => {
    it('notices an external rewrite that the native watcher never reports', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const events = watch(target);
        expect(native.listeners).toHaveLength(1);

        fs.writeFileSync(target, 'reset by git');

        await vi.waitFor(() => expect(events).toEqual(['change']), WAIT);
    });

    it('notices a replacement that the native watcher never reports', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const events = watch(target);

        // `git checkout` and `git reset` unlink the file and create a new one.
        await fs.promises.rm(target);
        await fs.promises.writeFile(target, 'committed version');

        await vi.waitFor(() => expect(events.at(-1)).toMatch(/^(change|create)$/), WAIT);
    });

    it('notices the end of a write the native watcher reported only partway through', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const events = watch(target);

        // The only native event lands while the writer is mid-file, so a reload
        // it triggers reads a truncated workbook. The rest of the write must
        // still raise an event, or the view keeps the unreadable read's result.
        fs.writeFileSync(target, 'PK');
        fire_native('change', target);
        expect(events).toEqual(['change']);
        fs.appendFileSync(target, ' and the rest of the archive');

        await vi.waitFor(() => expect(events).toEqual(['change', 'change']), WAIT);
    });

    it('does not report a change again once the native watcher reported it', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const events = watch(target);

        fs.writeFileSync(target, 'first external change');
        fire_native('change', target);
        expect(events).toEqual(['change']);
        // A second, unreported change is the observable end point: once it
        // arrives, every poll that could have repeated the first has run.
        fs.writeFileSync(target, 'second external change, unreported');

        await vi.waitFor(() => expect(events).toHaveLength(2), WAIT);
        expect(events).toEqual(['change', 'change']);
    });

    it('stops reconciling after dispose', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const disposed_events: string[] = [];
        const disposed = new NodeFileRefreshWatcherFactory({ poll_interval_ms: POLL_MS })
            .create(file_refresh_watch_identity(target));
        disposed.on_event((kind) => disposed_events.push(kind));
        disposed.dispose();
        // A live watcher on the same file is the observable end point: once it
        // has seen the change, the disposed one has had the same polls to miss.
        const live_events = watch(target);

        fs.writeFileSync(target, 'changed after dispose');

        await vi.waitFor(() => expect(live_events).toEqual(['change']), WAIT);
        expect(disposed_events).toEqual([]);
        expect(native.listeners).toHaveLength(1);
    });
});
