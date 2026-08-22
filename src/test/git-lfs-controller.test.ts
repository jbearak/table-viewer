/**
 * The controller side of Git LFS support: detecting a pointer on either side
 * before it reaches a parser, projecting it into the snapshot so the banner can
 * appear, and resolving it with the operation that side actually needs.
 *
 * The two sides are tested separately throughout, because they are not one
 * feature with a flag. A working-tree pointer means the grid has no data and
 * the fix is `pull`, which repairs the file on disk. A compare-original pointer
 * means the grid is fine and only the diff is missing, and the fix is `smudge`,
 * because a `git:` read returns the committed pointer blob however many times
 * it is retried.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    csv_table_profile,
    type ViewerControllerOptions,
} from '../viewer-controller';
import type { UnresolvedLfsObject } from '../viewer-snapshot';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import {
    fake_git_lfs,
    fake_viewer_host,
    fake_viewer_host_without_lfs,
} from './mocks/host-ports';

const enc = new TextEncoder();

const OID = 'b'.repeat(64);
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 24\n`;
/** Exactly 24 bytes, so a smudge outcome matches the pointer's stated size. */
const RESOLVED_CSV = 'h,k\nreal,rows\nmore,rows\n';
const MODIFIED = 'h\na\nb\n';
const ORIGINAL = 'h\nA\n';

type Posted = { type: string } & Record<string, unknown>;

function open_table(options: ViewerControllerOptions = {}, host = fake_viewer_host) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file('/tmp/data.csv') as unknown as vscode.Uri,
        with_in_memory_authority_transactions(versioned_state_store().store),
        csv_table_profile(),
        host,
        options,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function open_compare(host = fake_viewer_host) {
    return open_table({
        compare: {
            originalUri: vscode_mock.Uri.file('/tmp/original.csv') as unknown as vscode.Uri,
        },
    }, host);
}

function posted(panel: ReturnType<typeof open_table>, type: string): Posted[] {
    return (panel.__messages as Posted[]).filter((message) => message.type === type);
}

function snapshots(panel: ReturnType<typeof open_table>) {
    return posted(panel, 'workbookSnapshot').map((message) => message.snapshot as {
        configuration: { unresolvedLfs?: UnresolvedLfsObject };
        meta: { sheets: { rowCount: number; columnCount: number }[] };
    });
}

/** The most recent snapshot's LFS payload, once at least one has arrived. */
async function latest_lfs(
    panel: ReturnType<typeof open_table>,
    predicate: (value: UnresolvedLfsObject | undefined) => boolean = () => true,
): Promise<UnresolvedLfsObject | undefined> {
    let result: UnresolvedLfsObject | undefined;
    await vi.waitFor(() => {
        const all = snapshots(panel);
        expect(all.length).toBeGreaterThan(0);
        result = all[all.length - 1].configuration.unresolvedLfs;
        expect(predicate(result)).toBe(true);
    });
    return result;
}

/** Serve the pointer for the named side and real content for the other. */
function serve(pointer_side: 'file' | 'original' | 'none'): void {
    vscode_mock.__setReadFileImplementation(async (uri) => {
        const is_original = String(uri.fsPath ?? uri).includes('original');
        if (pointer_side === 'file' && !is_original) return enc.encode(POINTER);
        if (pointer_side === 'original' && is_original) return enc.encode(POINTER);
        return enc.encode(is_original ? ORIGINAL : MODIFIED);
    });
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    fake_git_lfs.reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
    serve('none');
});

describe('a working-tree file that is an LFS pointer', () => {
    it('reports the pointer instead of parsing it into a grid', async () => {
        serve('file');
        const panel = open_table();
        await panel.__receive({ type: 'ready' });
        const unresolved = await latest_lfs(panel, (value) => value !== undefined);
        expect(unresolved).toEqual({
            side: 'file',
            oid: OID,
            size: 24,
            resolvable: true,
        });
        // The regression this feature exists for: CSV happily parses the
        // pointer's three lines into a grid that looks like real data.
        const { sheets } = snapshots(panel)[snapshots(panel).length - 1].meta;
        expect(sheets[0].rowCount).toBe(0);
        expect(sheets[0].columnCount).toBe(0);
    });

    it('says the object is unresolvable on a host with no git-lfs port', async () => {
        serve('file');
        const panel = open_table({}, fake_viewer_host_without_lfs);
        await panel.__receive({ type: 'ready' });
        // The notice still stands — this is the point of reporting it at all —
        // it just cannot offer a button.
        expect(await latest_lfs(panel, (value) => value !== undefined))
            .toMatchObject({ side: 'file', resolvable: false });
    });

    it('pulls the file, then shows the real table', async () => {
        serve('file');
        const panel = open_table();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        // git lfs pull materializes the bytes on disk, so the next read finds
        // real content — which is exactly what the fake filesystem models here.
        fake_git_lfs.pull_outcomes.push({ type: 'resolved' });
        serve('none');
        await panel.__receive({ type: 'resolveLfsObject' });
        await latest_lfs(panel, (value) => value === undefined);
        expect(fake_git_lfs.calls).toEqual([
            { operation: 'pull', path: '/tmp/data.csv' },
        ]);
        const latest = snapshots(panel)[snapshots(panel).length - 1];
        expect(latest.meta.sheets[0].rowCount).toBeGreaterThan(0);
    });

    it('keeps the notice and explains why when the pull fails', async () => {
        serve('file');
        const panel = open_table();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        fake_git_lfs.pull_outcomes.push({
            type: 'failed',
            reason: 'failed',
            detail: 'Object does not exist on the remote',
        });
        await panel.__receive({ type: 'resolveLfsObject' });
        // The banner has to be able to say *why*: a silent no-op on the second
        // click is the failure mode this replaces.
        expect(await latest_lfs(panel, (value) => value?.failure !== undefined))
            .toMatchObject({
                side: 'file',
                failure: { reason: 'failed', detail: 'Object does not exist on the remote' },
            });
    });

    it('reports a missing git-lfs distinctly from a failed download', async () => {
        serve('file');
        const panel = open_table();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        fake_git_lfs.pull_outcomes.push({ type: 'failed', reason: 'lfsNotInstalled' });
        await panel.__receive({ type: 'resolveLfsObject' });
        // Distinct because it is the one failure where retrying is pointless,
        // and the banner drops the button for it.
        expect((await latest_lfs(panel, (value) => value?.failure !== undefined))
            ?.failure?.reason).toBe('lfsNotInstalled');
    });

    it('keeps the notice when git-lfs claims success but changes nothing', async () => {
        // Not hypothetical: verified against git-lfs 3.7.1, where a repository
        // without `git lfs install` makes `git lfs pull` print "Skipping object
        // checkout" and exit 0 with the pointer untouched. The port converts
        // that into a failure, and the banner has to survive it — clearing it
        // would leave an empty grid with nothing to press.
        serve('file');
        const panel = open_table();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        fake_git_lfs.pull_outcomes.push({
            type: 'failed',
            reason: 'filtersNotConfigured',
        });
        await panel.__receive({ type: 'resolveLfsObject' });
        expect(await latest_lfs(panel, (value) => value?.failure !== undefined))
            .toMatchObject({ side: 'file', failure: { reason: 'filtersNotConfigured' } });
    });

    it('does not restore the banner when the reload it triggered was superseded', async () => {
        // The bug that made the button look broken on a real file. A successful
        // `git lfs pull` rewrites the working tree, which wakes the file-refresh
        // watcher, whose reload supersedes the resolve's own. Supersession makes
        // `refresh_panel_source` return false exactly as a failure does, so the
        // handler treated the win as a loss and put the banner back — over the
        // real table the superseding load had already delivered.
        serve('file');
        const panel = open_table();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        fake_git_lfs.pull_outcomes.push({ type: 'resolved' });
        // Stand in for git-lfs writing the file: real content from here on, and
        // a watcher event landing while the resolve is still in flight.
        serve('none');
        vscode_mock.__setStatImplementation(async () => ({ size: 99, mtime: 9 }));
        const resolving = panel.__receive({ type: 'resolveLfsObject' });
        for (const watcher of vscode_mock.__getWatchers()) await watcher.__fireChange();
        await resolving;
        // The file is no longer a pointer, so no banner — whichever load won.
        await vi.waitFor(() => {
            const all = snapshots(panel);
            expect(all[all.length - 1].configuration.unresolvedLfs).toBeUndefined();
            expect(all[all.length - 1].meta.sheets[0].rowCount).toBeGreaterThan(0);
        });
    });

    it('ignores a resolve request when nothing is unresolved', async () => {
        const panel = open_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(snapshots(panel).length).toBeGreaterThan(0));
        await panel.__receive({ type: 'resolveLfsObject' });
        expect(fake_git_lfs.calls).toEqual([]);
    });
});

describe('a compare original that is an LFS pointer', () => {
    it('shows the file plainly and reports the unresolved original', async () => {
        serve('original');
        const panel = open_compare();
        await panel.__receive({ type: 'ready' });
        const unresolved = await latest_lfs(panel, (value) => value !== undefined);
        expect(unresolved).toMatchObject({ side: 'original', oid: OID, size: 24 });
        // The modified side is real and readable, so the user still gets their
        // table — only the diff is missing.
        const latest = snapshots(panel)[snapshots(panel).length - 1];
        expect(latest.meta.sheets[0].rowCount).toBeGreaterThan(0);
        expect(latest.configuration).not.toHaveProperty('gitCompare.counts.changedCells', 1);
    });

    it('smudges rather than pulling, and then produces a real diff', async () => {
        serve('original');
        const panel = open_compare();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        fake_git_lfs.smudge_outcomes.push({
            type: 'resolved',
            content: enc.encode(RESOLVED_CSV),
        });
        await panel.__receive({ type: 'resolveLfsObject' });
        await latest_lfs(panel, (value) => value === undefined);
        // Smudge, not pull: there is no working-tree file behind a `git:`
        // revision to repair, and pulling would fix the wrong thing.
        expect(fake_git_lfs.calls).toEqual([
            { operation: 'smudge', path: '/tmp/original.csv', oid: OID },
        ]);
        const latest = snapshots(panel)[snapshots(panel).length - 1] as unknown as {
            configuration: { gitCompare?: { counts: { addedRows: number } } };
        };
        expect(latest.configuration.gitCompare).toBeDefined();
    });

    it('reuses the smudged bytes across a refresh instead of downloading again', async () => {
        serve('original');
        const panel = open_compare();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        fake_git_lfs.smudge_outcomes.push({
            type: 'resolved',
            content: enc.encode(RESOLVED_CSV),
        });
        await panel.__receive({ type: 'resolveLfsObject' });
        await latest_lfs(panel, (value) => value === undefined);
        // A `git:` read returns the pointer blob forever, so without the cache
        // a second click — or any later rebuild — would download it again. The
        // resolve is what proves it: the banner is gone, so a rebuild that had
        // not reused the bytes would have put it straight back.
        expect(fake_git_lfs.calls.filter((call) => call.operation === 'smudge'))
            .toHaveLength(1);
        // And a redundant request now does nothing, because nothing is
        // unresolved any more.
        await panel.__receive({ type: 'resolveLfsObject' });
        expect(fake_git_lfs.calls.filter((call) => call.operation === 'smudge'))
            .toHaveLength(1);
    });

    it('keeps the notice when the smudge fails', async () => {
        serve('original');
        const panel = open_compare();
        await panel.__receive({ type: 'ready' });
        await latest_lfs(panel, (value) => value !== undefined);
        fake_git_lfs.smudge_outcomes.push({ type: 'failed', reason: 'failed' });
        await panel.__receive({ type: 'resolveLfsObject' });
        expect(await latest_lfs(panel, (value) => value?.failure !== undefined))
            .toMatchObject({ side: 'original', failure: { reason: 'failed' } });
    });
});

describe('both sides at once', () => {
    it('reports the file rather than the original, and does not fetch the original', async () => {
        // Both sides are pointers. The file's emptiness is the fact that
        // matters: there is nothing to diff against, and fetching the original
        // would spend a download on an alignment against an empty grid.
        vscode_mock.__setReadFileImplementation(async () => enc.encode(POINTER));
        const panel = open_compare();
        await panel.__receive({ type: 'ready' });
        expect(await latest_lfs(panel, (value) => value !== undefined))
            .toMatchObject({ side: 'file' });
        fake_git_lfs.pull_outcomes.push({ type: 'resolved' });
        await panel.__receive({ type: 'resolveLfsObject' });
        await vi.waitFor(() => expect(fake_git_lfs.calls.length).toBeGreaterThan(0));
        expect(fake_git_lfs.calls[0].operation).toBe('pull');
    });
});
