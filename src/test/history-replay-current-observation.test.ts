/**
 * A history replay's commit across a view that moved, or seemed to.
 *
 * Two facts the commit used to get wrong (bug batch 3, A3):
 *  - A refresh that finds the file as it was keeps the acknowledged source but
 *    installs its candidate's observation, a new object equal to the old one.
 *    Compared by identity, that read as a changed file.
 *  - A view that moved while `commit_history_replay`'s own compare-and-swap was
 *    running was answered as `conflict` or `unavailable` depending on where it
 *    landed, and a view that moved after the write landed was answered as
 *    `document-changed`, which the window tries again. Once written, a
 *    replay is answered as committed, `viewMoved` when the view moved after
 *    the write.
 *
 * "A delivery" below is a snapshot the host posts and the window has not
 * acknowledged yet. Snapshots are not acknowledged automatically here, so one
 * posted mid-commit leaves the view moved for the rest of that commit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerController } from '../viewer-controller';
import type { FileStateStore } from '../state';
import type { HostMessage, WebviewMessage } from '../types';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import { messages_of } from './helpers/panel-messages';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const file_path = '/tmp/history-replay-current-observation.csv';
const CONTENT = 'h\na\nb\n';
const SHEET = { sheetIndex: 0, sheetName: 'Sheet1' };

type Panel = ReturnType<typeof vscode_mock.window.createWebviewPanel>;
type Hook = () => Promise<void>;

/**
 * A state store that can stop at one of its own steps until the test has done
 * something there. Each hook runs once, on the next call that reaches it.
 *
 * `reads` is consumed one entry per `read`, in order, so `[undefined, hook]`
 * lets the first read through and holds the second. `after_write` runs after
 * a compare-and-swap has committed and before its result is returned.
 */
function hooked_store() {
    const base = versioned_state_store();
    const hooks: { reads: (Hook | undefined)[]; after_write?: Hook } = { reads: [] };
    const store: FileStateStore = {
        ...base.store,
        async read(path) {
            const hook = hooks.reads.shift();
            if (hook) await hook();
            return base.store.read(path);
        },
        async compare_and_set(...args) {
            const result = await base.store.compare_and_set(...args);
            const hook = hooks.after_write;
            if (result.type === 'committed' && hook) {
                hooks.after_write = undefined;
                await hook();
            }
            return result;
        },
    };
    return { base, store, hooks };
}

function open_csv_table(store: FileStateStore): { panel: Panel; controller: ViewerController } {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(store),
        csv_table_profile(),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return { panel, controller };
}

/** Load the table and acknowledge its snapshot, and stop acknowledging any later one. */
async function ready(panel: Panel): Promise<void> {
    panel.__autoAckSnapshots = false;
    await panel.__receive({ type: 'ready' });
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length)
        .toBeGreaterThan(0));
    const latest = messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
    await panel.__receive({
        type: 'snapshotApplied',
        identity: latest.identity,
        disposition: 'applied',
    } satisfies Extract<WebviewMessage, { type: 'snapshotApplied' }>);
}

/**
 * Have the host post a delivery, and wait until it is out.
 *
 * Granting an edit session changes the panel's capabilities, which the host
 * delivers as a fresh snapshot. The window does not acknowledge it, so from
 * this point on the view the replay was prepared against is not current.
 */
async function post_delivery(panel: Panel): Promise<void> {
    const before = messages_of(panel, 'workbookSnapshot').length;
    void panel.__receive({ type: 'requestEditSession' } as never);
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length)
        .toBeGreaterThan(before));
}

let next_replay = 0;

async function prepare_highlight(
    panel: Panel,
): Promise<Extract<HostMessage, { type: 'historyReplayPrepared' }>['prepared']> {
    const replay = `replay-${next_replay += 1}`;
    await panel.__receive({
        type: 'prepareHistoryReplay',
        request: {
            requestId: `prepare-${next_replay}`,
            replayId: replay,
            cells: [],
            highlights: [{
                ordinal: 0,
                worksheet: SHEET,
                sourceRow: 0,
                sourceColumn: 0,
                expected: null,
                desired: 'yellow',
            }],
            focus: {
                worksheet: SHEET,
                sourceRowStart: 0,
                sourceRowEnd: 0,
                sourceColumnStart: 0,
                sourceColumnEnd: 0,
            },
        },
    } satisfies Extract<WebviewMessage, { type: 'prepareHistoryReplay' }>);
    const answers = () => [
        ...messages_of(panel, 'historyReplayPrepared')
            .filter((message) => message.prepared.replayId === replay),
        ...messages_of(panel, 'historyReplayPrepareRefused')
            .filter((message) => message.refusal.replayId === replay),
    ];
    await vi.waitFor(() => expect(answers()).toHaveLength(1));
    const [answer] = answers();
    expect(answer.type).toBe('historyReplayPrepared');
    return (answer as Extract<HostMessage, { type: 'historyReplayPrepared' }>).prepared;
}

/** Send the commit, and return the host's one answer to it. */
async function commit(
    panel: Panel,
    prepared: Extract<HostMessage, { type: 'historyReplayPrepared' }>['prepared'],
): Promise<
    | Extract<HostMessage, { type: 'historyReplayCommitted' }>
    | Extract<HostMessage, { type: 'historyReplayCommitRefused' }>
> {
    void panel.__receive({
        type: 'commitHistoryReplay',
        request: {
            requestId: prepared.requestId,
            replayId: prepared.replayId,
            leaseId: prepared.leaseId,
            mutationId: `mutation-${prepared.replayId}`,
            cells: [],
            highlights: [{ ordinal: 0 }],
        },
    } satisfies Extract<WebviewMessage, { type: 'commitHistoryReplay' }>);
    const answers = () => [
        ...messages_of(panel, 'historyReplayCommitted')
            .filter((message) => message.committed.replayId === prepared.replayId),
        ...messages_of(panel, 'historyReplayCommitRefused')
            .filter((message) => message.refusal.replayId === prepared.replayId),
    ];
    await vi.waitFor(() => expect(answers()).toHaveLength(1));
    return answers()[0];
}

function refusal_reason(answer: Awaited<ReturnType<typeof commit>>): string | undefined {
    return answer.type === 'historyReplayCommitRefused' ? answer.refusal.reason : undefined;
}

/** The highlight the replay writes, as durable state holds it, or undefined. */
function durable_highlight(base: ReturnType<typeof versioned_state_store>): unknown {
    return base.get_state(file_path).cellHighlights?.sheets?.[0]?.cells?.['0:0'];
}

/** The replayed cell's highlight in a delivered snapshot, or undefined. */
function snapshot_highlight(snapshot: unknown): unknown {
    return (snapshot as { state?: { cellHighlights?: { sheets?: { cells?: Record<string, unknown> }[] } } })
        .state?.cellHighlights?.sheets?.[0]?.cells?.['0:0'];
}

let bytes = enc.encode(CONTENT);
let mtime = 1;

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    bytes = enc.encode(CONTENT);
    mtime = 1;
    vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime }));
    vscode_mock.__setReadFileImplementation(async () => bytes);
});

describe('a replay across a refresh of its file', () => {
    it('commits after a refresh that found the file as it was and installed an equal observation', async () => {
        const { base, store } = hooked_store();
        const { panel, controller } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        const authority = with_in_memory_authority_transactions(store);
        const sequence_before = (await authority.read_authority(file_path)).commitSequence;
        const snapshots_before = messages_of(panel, 'workbookSnapshot').length;

        // The same bytes, the same stat: the refresh keeps the acknowledged
        // source, commits a stage with the same digest, and installs the new
        // candidate's observation.
        expect(await controller.refresh_if_changed()).toBe(true);
        const after = await authority.read_authority(file_path);
        expect(after.commitSequence).toBeGreaterThan(sequence_before);
        expect(messages_of(panel, 'workbookSnapshot')).toHaveLength(snapshots_before);

        const answer = await commit(panel, prepared);

        expect(refusal_reason(answer)).toBeUndefined();
        expect(answer.type).toBe('historyReplayCommitted');
        expect(durable_highlight(base)).toBe('yellow');
    });

    it('refuses after a refresh that found different bytes', async () => {
        const { base, store } = hooked_store();
        const { panel, controller } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);

        bytes = enc.encode('h\nx\nb\n');
        mtime = 2;
        expect(await controller.refresh_if_changed()).toBe(true);

        const answer = await commit(panel, prepared);

        expect(answer.type).toBe('historyReplayCommitRefused');
        expect(refusal_reason(answer)).toBe('expired');
        expect(durable_highlight(base)).toBeUndefined();
    });
});

describe('a replay whose view moves while its commit runs', () => {
    it('refuses document-changed when a delivery lands before the commit reads durable state', async () => {
        const { base, store } = hooked_store();
        const { panel } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        // The commit's first await on the file is the stat that re-verifies
        // the bytes, which comes before `update_file_state` reads anything.
        let stalled = false;
        vscode_mock.__setStatImplementation(async () => {
            if (!stalled) {
                stalled = true;
                await post_delivery(panel);
            }
            return { size: bytes.byteLength, mtime };
        });

        const answer = await commit(panel, prepared);

        expect(stalled).toBe(true);
        expect(refusal_reason(answer)).toBe('document-changed');
        expect(durable_highlight(base)).toBeUndefined();
    });

    it('refuses document-changed when a delivery lands during the commit\'s own state read', async () => {
        // The read is `update_file_state`'s first, so its validation fails and
        // the updater never runs: nothing was compared, so not a conflict.
        const { base, store, hooks } = hooked_store();
        const { panel } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        let stalled = false;
        hooks.reads = [async () => {
            stalled = true;
            await post_delivery(panel);
        }];

        const answer = await commit(panel, prepared);

        expect(stalled).toBe(true);
        expect(refusal_reason(answer)).toBe('document-changed');
        expect(durable_highlight(base)).toBeUndefined();
    });

    it('refuses document-changed when a delivery lands while the updater\'s write is in flight', async () => {
        // The nearest reachable form of "inside the updater": `update_file_state`
        // validates with the same check the updater makes, synchronously before
        // calling it, so the updater cannot itself find the view moved. Here the
        // updater has run and its compare-and-swap is reading the state (the
        // second read), the delivery lands, and the swap's validation refuses:
        // the updater ran, and nothing was written.
        const { base, store, hooks } = hooked_store();
        const { panel } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        let stalled = false;
        hooks.reads = [undefined, async () => {
            stalled = true;
            await post_delivery(panel);
        }];

        const answer = await commit(panel, prepared);

        expect(stalled).toBe(true);
        expect(refusal_reason(answer)).toBe('document-changed');
        expect(durable_highlight(base)).toBeUndefined();
    });

    it('answers committed, saying the view moved, when the view moves after the commit\'s write landed', async () => {
        const { base, store, hooks } = hooked_store();
        const { panel } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        let moved = false;
        hooks.after_write = async () => {
            moved = true;
            await post_delivery(panel);
        };

        const answer = await commit(panel, prepared);

        expect(moved).toBe(true);
        expect(answer.type).toBe('historyReplayCommitted');
        expect(answer.type === 'historyReplayCommitted' && answer.committed.viewMoved).toBe(true);
        // The revision its write produced: the floor for later deliveries.
        expect(answer.type === 'historyReplayCommitted' && answer.committed.stateRevision)
            .toBe((await base.store.read(file_path)).revision);
        expect(durable_highlight(base)).toBe('yellow');
    });

    it('after a commit whose view moved after the write, delivers the view with the write in it', async () => {
        // The delivery that moved the view went out before the session held
        // the write, so it shows the cell as it was. The window takes its
        // stores from the delivery after the answer: one must follow.
        const { store, hooks } = hooked_store();
        const { panel } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        let moved_view: unknown;
        hooks.after_write = async () => {
            await post_delivery(panel);
            moved_view = messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
        };

        const answer = await commit(panel, prepared);

        expect(answer.type === 'historyReplayCommitted' && answer.committed.viewMoved).toBe(true);
        expect(snapshot_highlight(moved_view)).toBeUndefined();
        const after_answer = () => panel.__messages.slice(panel.__messages.indexOf(answer))
            .filter((message): message is Extract<HostMessage, { type: 'workbookSnapshot' }> =>
                (message as { type?: string }).type === 'workbookSnapshot');
        await vi.waitFor(() => expect(after_answer().length).toBeGreaterThan(0));
        expect(snapshot_highlight(after_answer().at(-1)!.snapshot)).toBe('yellow');
    });

    it('answers committed when recording the committed write fails after it landed', async () => {
        // The bookkeeping after a durable write throws (here, a committed
        // result it cannot read). The write is in the file all the same.
        const { base, store } = hooked_store();
        const compare_and_set = store.compare_and_set.bind(store);
        let broken = false;
        store.compare_and_set = async (...args) => {
            const result = await compare_and_set(...args);
            if (broken || result.type !== 'committed') return result;
            broken = true;
            return { ...result, snapshot: { ...result.snapshot, state: null as never } };
        };
        const { panel } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        broken = false;
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        // The state read back to repair the session (the first read after
        // the broken write) is held until the answer has gone out.
        let release_read!: () => void;
        const read_held = new Promise<void>((resolve) => { release_read = resolve; });
        const read = store.read.bind(store);
        let held = false;
        store.read = async (...args) => {
            if (broken && !held) {
                held = true;
                await read_held;
            }
            return read(...args);
        };

        const answer = await commit(panel, prepared);

        expect(broken).toBe(true);
        expect(answer.type).toBe('historyReplayCommitted');
        expect(durable_highlight(base)).toBe('yellow');

        // Once the read lands, a delivery carries the write.
        const delivered_before = messages_of(panel, 'workbookSnapshot').length;
        release_read();
        await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length)
            .toBeGreaterThan(delivered_before));
        expect(snapshot_highlight(messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot)).toBe('yellow');
    });

    it('still answers conflict when the durable highlight differs from the one the replay expects', async () => {
        const { base, store } = hooked_store();
        const { panel } = open_csv_table(store);
        await ready(panel);
        const prepared = await prepare_highlight(panel);
        // Another writer colours the cell the replay expects to be uncoloured.
        // Durable state only: the view the replay was prepared against stays
        // current, so the compare inside the updater is what refuses.
        const { physicalDigest } = await with_in_memory_authority_transactions(store)
            .read_authority(file_path);
        const current = await base.store.read(file_path);
        const written = await base.store.compare_and_set(file_path, current.revision, {
            ...current.state,
            cellHighlights: {
                sourceDigest: physicalDigest,
                sheets: [{ schema: '["Sheet1",1,["h"]]', cells: { '0:0': 'green' } }],
            },
        } as never);
        expect(written.type).toBe('committed');

        const answer = await commit(panel, prepared);

        expect(refusal_reason(answer)).toBe('conflict');
        expect(durable_highlight(base)).toBe('green');
    });
});
