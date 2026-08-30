import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { file_refresh_watch_identity } from '../file-refresh-watcher';
import { NodeFileRefreshWatcherFactory } from '../node-file-refresh-watcher';

const POLL_MS = 10;
const WAIT = { timeout: 5000, interval: 10 };

let temp_dir: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
    temp_dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-node-watch-'));
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await fs.promises.rm(temp_dir, { recursive: true, force: true });
});

function polling_factory(): NodeFileRefreshWatcherFactory {
    return new NodeFileRefreshWatcherFactory({
        force_polling: true,
        poll_interval_ms: POLL_MS,
    });
}

function watch(factory: NodeFileRefreshWatcherFactory, file_path: string) {
    const watcher = factory.create(file_refresh_watch_identity(file_path));
    cleanups.push(() => watcher.dispose());
    const events: string[] = [];
    const subscription = watcher.on_event((kind) => events.push(kind));
    return { watcher, events, subscription };
}

describe('Node file refresh watcher adapter', () => {
    it('emits change, delete, and create through the polling fallback', async () => {
        const target = path.join(temp_dir, 'book.csv');
        await fs.promises.writeFile(target, 'a,b\n1,2\n');
        const { events } = watch(polling_factory(), target);

        await fs.promises.writeFile(target, 'a,b\n1,2\n3,4\n');
        await vi.waitFor(() => expect(events).toContain('change'), WAIT);

        await fs.promises.rm(target);
        await vi.waitFor(() => expect(events).toContain('delete'), WAIT);

        await fs.promises.writeFile(target, 'a,b\n');
        await vi.waitFor(() => expect(events).toContain('create'), WAIT);
    });

    it('emits events for a watched file via fs.watch on the directory', async () => {
        const target = path.join(temp_dir, 'native.csv');
        await fs.promises.writeFile(target, 'a\n');
        const { events } = watch(new NodeFileRefreshWatcherFactory(), target);

        // Small delay so the native watcher is registered before the write.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fs.promises.writeFile(target, 'a\nb\n');

        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), WAIT);
        expect(events.every((kind) => ['change', 'create', 'delete'].includes(kind)))
            .toBe(true);
    });

    it('emits an event when an external tool replaces the watched file', async () => {
        const target = path.join(temp_dir, 'restored.xlsx');
        const replacement = path.join(temp_dir, 'git-checkout.xlsx');
        await fs.promises.writeFile(target, 'locally changed');
        const { events } = watch(
            new NodeFileRefreshWatcherFactory({ poll_interval_ms: POLL_MS }),
            target,
        );

        for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) {
            await fs.promises.appendFile(target, '.');
            await new Promise((done) => { setTimeout(done, 10); });
        }
        expect(events.length).toBeGreaterThan(0);
        events.splice(0);
        await fs.promises.writeFile(replacement, 'committed version');
        await fs.promises.rename(replacement, target);

        for (let attempt = 0; attempt < 200 && events.length === 0; attempt += 1) {
            await new Promise((done) => { setTimeout(done, 10); });
        }
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((kind) => ['change', 'create'].includes(kind))).toBe(true);
    });

    it('ignores events for sibling files in the same directory', async () => {
        const target = path.join(temp_dir, 'target.csv');
        const sibling = path.join(temp_dir, 'sibling.csv');
        await fs.promises.writeFile(target, 'a\n');
        await fs.promises.writeFile(sibling, 'a\n');
        const { events } = watch(new NodeFileRefreshWatcherFactory(), target);

        await new Promise((resolve) => setTimeout(resolve, 100));
        await fs.promises.writeFile(sibling, 'a\nb\n');
        await fs.promises.writeFile(target, 'a\nb\n');

        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), WAIT);
        // Only the target file's canonical key matches; sibling writes never
        // surface, so every observed event belongs to the target.
        await fs.promises.rm(sibling);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(events).not.toContain('delete');
    });

    it('falls back to polling when the directory cannot be natively watched', async () => {
        const missing_dir = path.join(temp_dir, 'missing');
        const target = path.join(missing_dir, 'late.csv');
        const factory = new NodeFileRefreshWatcherFactory({ poll_interval_ms: POLL_MS });
        const { events } = watch(factory, target);

        await fs.promises.mkdir(missing_dir, { recursive: true });
        await fs.promises.writeFile(target, 'a\n');

        await vi.waitFor(() => expect(events).toContain('create'), WAIT);
    });

    it('stops delivering to unsubscribed listeners and after dispose', async () => {
        const target = path.join(temp_dir, 'unsub.csv');
        await fs.promises.writeFile(target, 'a\n');
        const { watcher, events, subscription } = watch(polling_factory(), target);

        await fs.promises.writeFile(target, 'a\nb\n');
        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), WAIT);
        const seen = events.length;

        subscription.dispose();
        subscription.dispose();
        await fs.promises.writeFile(target, 'a\nb\nc\n');
        await new Promise((resolve) => setTimeout(resolve, 5 * POLL_MS));
        expect(events.length).toBe(seen);

        const late = vi.fn();
        watcher.on_event(late);
        watcher.dispose();
        watcher.dispose();
        expect(watcher.on_event(() => {})).toMatchObject({ dispose: expect.any(Function) });
        await fs.promises.writeFile(target, 'a,b,c,d\n');
        await new Promise((resolve) => setTimeout(resolve, 5 * POLL_MS));
        expect(late).not.toHaveBeenCalled();
    });

    it('rejects provider identities', () => {
        const factory = new NodeFileRefreshWatcherFactory();
        expect(() => factory.create(file_refresh_watch_identity({
            scheme: 'memfs',
            authority: 'workspace',
            path: '/reports/book.csv',
            query: '',
            fragment: '',
            fsPath: '/reports/book.csv',
        }))).toThrow('Node file refresh watcher only supports file resources.');
    });
});
