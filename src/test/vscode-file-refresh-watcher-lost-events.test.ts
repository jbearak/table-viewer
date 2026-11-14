import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { file_refresh_watch_identity } from '../file-refresh-watcher';
import { VscodeFileRefreshWatcherFactory } from '../vscode-file-refresh-watcher';
import * as vscode_mock from './mocks/vscode';

/**
 * VS Code's `createFileSystemWatcher` rests on the same OS notifications as
 * Node's `fs.watch` (FSEvents on macOS) and loses events under load the same
 * way. The mock watcher reports only what each test fires by hand, so a
 * dropped event is deterministic rather than a matter of machine load.
 *
 * Writes a test counts events after are synchronous. An async write truncates
 * the file before it writes, and a poll landing between the two would report a
 * change of its own.
 */
const POLL_MS = 10;
const WAIT = { timeout: 5000, interval: 10 };

let temp_dir: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
    vscode_mock.__reset();
    temp_dir = await fs.promises.realpath(
        await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-vscode-watch-lost-')),
    );
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await fs.promises.rm(temp_dir, { recursive: true, force: true });
});

function watch(file_path: string) {
    const watcher = new VscodeFileRefreshWatcherFactory({ poll_interval_ms: POLL_MS })
        .create(file_refresh_watch_identity(vscode_mock.Uri.file(file_path)));
    cleanups.push(() => watcher.dispose());
    const events: string[] = [];
    watcher.on_event((kind) => events.push(kind));
    return { events, vscode_watcher: vscode_mock.__getWatchers().at(-1)! };
}

describe('VS Code file refresh watcher when VS Code loses events', () => {
    it('notices an external rewrite that VS Code never reports', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const { events } = watch(target);

        fs.writeFileSync(target, 'reset by git');

        await vi.waitFor(() => expect(events).toEqual(['change']), WAIT);
    });

    it('notices a replacement that VS Code never reports', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const { events } = watch(target);

        // `git checkout` and `git reset` unlink the file and create a new one.
        await fs.promises.rm(target);
        await fs.promises.writeFile(target, 'committed version');

        await vi.waitFor(() => expect(events.at(-1)).toMatch(/^(change|create)$/), WAIT);
    });

    it('notices the end of a write VS Code reported only partway through', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const { events, vscode_watcher } = watch(target);

        fs.writeFileSync(target, 'PK');
        await vscode_watcher.__fireChange();
        expect(events).toEqual(['change']);
        fs.appendFileSync(target, ' and the rest of the archive');

        await vi.waitFor(() => expect(events).toEqual(['change', 'change']), WAIT);
    });

    it('does not report a change again once VS Code reported it', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const { events, vscode_watcher } = watch(target);

        fs.writeFileSync(target, 'first external change');
        await vscode_watcher.__fireChange();
        expect(events).toEqual(['change']);
        // A second, unreported change is the observable end point: once it
        // arrives, every poll that could have repeated the first has run.
        fs.writeFileSync(target, 'second external change, unreported');

        await vi.waitFor(() => expect(events).toHaveLength(2), WAIT);
        expect(events).toEqual(['change', 'change']);
    });

    it('stops polling after dispose', async () => {
        const target = path.join(temp_dir, 'book.xlsx');
        await fs.promises.writeFile(target, 'saved by Table Viewer');
        const disposed_events: string[] = [];
        const disposed = new VscodeFileRefreshWatcherFactory({ poll_interval_ms: POLL_MS })
            .create(file_refresh_watch_identity(vscode_mock.Uri.file(target)));
        disposed.on_event((kind) => disposed_events.push(kind));
        disposed.dispose();
        // A live watcher on the same file is the observable end point: once it
        // has seen the change, the disposed one has had the same polls to miss.
        const { events: live_events } = watch(target);

        fs.writeFileSync(target, 'changed after dispose');

        await vi.waitFor(() => expect(live_events).toEqual(['change']), WAIT);
        expect(disposed_events).toEqual([]);
    });
});
