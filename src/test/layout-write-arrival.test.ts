/**
 * A `stateChanged` that waits its turn behind another layout write, while the
 * host delivers a snapshot from somewhere else.
 *
 * The message names the snapshot it is a difference from. The host used to
 * check that name when the message reached the head of the layout queue, so
 * any delivery made while it waited there refused it, and the scroll position
 * or the show-formatting choice it carried was lost without a word. What only
 * the name can give is read when the message arrives; applying it asks the
 * host's own terms; and a write that landed under a delivery is followed by
 * one that carries it, so the window ends on what is stored.
 *
 * One test per place that delivers outside the queue, each failing before the
 * change, then the rules for the state the next message is a difference from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import type { PerFileState, WebviewMessage } from '../types';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import { messages_of } from './helpers/panel-messages';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const file_path = '/tmp/layout-write-arrival.csv';
const CONTENT = 'h\nc\na\nb\n';
const SHEET = { sheetIndex: 0, sheetName: 'Sheet1' };

type Panel = ReturnType<typeof vscode_mock.window.createWebviewPanel>;
type AuthorityStore = ReturnType<typeof with_in_memory_authority_transactions>;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function open_csv(store: AuthorityStore): Panel {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        store,
        csv_table_profile(),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

const latest_snapshot = (panel: Panel): WorkbookSnapshot =>
    messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;

/** Bring the panel up and acknowledge its snapshot: a layout change is refused until then. */
async function ready_and_acknowledged(panel: Panel): Promise<WorkbookSnapshot> {
    await panel.__receive({ type: 'ready' });
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
    const snapshot = latest_snapshot(panel);
    await panel.__receive({ type: 'snapshotApplied', identity: snapshot.identity, disposition: 'applied' });
    return snapshot;
}

const snapshots_since = (panel: Panel, from: number): WorkbookSnapshot[] =>
    messages_of({ __messages: panel.__messages.slice(from) }, 'workbookSnapshot')
        .map((message) => message.snapshot);

/** Another writer's turn, taken right after one of this window's writes commits. */
type AfterCommit = (
    next: PerFileState,
    versioned: ReturnType<typeof versioned_state_store>,
) => Promise<void>;

/**
 * A store whose first write matching `holds` commits and then does not return
 * until released. The gate is outside the per-file queue, so the write has
 * left that queue and still occupies the layout queue: what arrives next
 * waits behind it while other writers go through.
 */
function holding_store(
    initial: PerFileState,
    holds: (next: PerFileState) => boolean,
    after_commit?: AfterCommit,
) {
    const versioned = versioned_state_store(initial);
    const committed = deferred();
    const release = deferred();
    let hold = true;
    const queued = with_in_memory_authority_transactions(versioned.store);
    const store: typeof queued = {
        ...queued,
        async compare_and_set(path, expected, next, validate, basis) {
            const result = await queued.compare_and_set(path, expected, next, validate, basis);
            if (result.type === 'committed') await after_commit?.(next, versioned);
            if (hold && holds(next) && result.type === 'committed') {
                hold = false;
                committed.resolve();
                await release.promise;
            }
            return result;
        },
    };
    return { versioned, store, committed: committed.promise, release: release.resolve };
}

/** Open, then hold the layout queue with a scroll to row 50. */
async function open_with_held_layout_write(initial: PerFileState = {}, after_commit?: AfterCommit) {
    const held = holding_store(initial, (next) => next.scrollPosition?.[0]?.top === 50, after_commit);
    const panel = open_csv(held.store);
    const ready = await ready_and_acknowledged(panel);
    const layout = (state: PerFileState) => ({
        type: 'stateChanged',
        sourceGeneration: ready.sourceGeneration,
        snapshotIdentity: ready.identity,
        state: { ...ready.state, ...state },
    } satisfies Extract<WebviewMessage, { type: 'stateChanged' }>);
    const first = panel.__receive(layout({ scrollPosition: [{ top: 50, left: 0 }] }));
    await held.committed;
    return { ...held, panel, ready, layout, first };
}

/** What the person did while the first write was still being stored. */
const WAITING: PerFileState = { scrollPosition: [{ top: 77, left: 0 }], showFormatting: [false] };

/**
 * Queue `WAITING` behind the held write, let `deliver` post a snapshot from
 * outside the layout queue, then release. The waiting change must be stored,
 * and a snapshot carrying it must follow the one that intervened.
 */
async function expect_waiting_change_survives(
    deliver: (context: Awaited<ReturnType<typeof open_with_held_layout_write>>) => Promise<void>,
    after_commit?: AfterCommit,
): Promise<void> {
    const context = await open_with_held_layout_write({}, after_commit);
    const { panel, versioned, layout, first, release } = context;
    const second = panel.__receive(layout(WAITING));
    const from = panel.__messages.length;

    await deliver(context);
    // The delivery really came from outside the queue: it is posted while the
    // first write still holds it, and it does not carry the waiting change.
    await vi.waitFor(() => expect(snapshots_since(panel, from).length).toBeGreaterThan(0));
    const intervening = snapshots_since(panel, from).length;
    expect(latest_snapshot(panel).state.showFormatting).not.toEqual([false]);

    release();
    // Both handlers have run to their end once these resolve.
    await Promise.all([first, second]);

    const durable = versioned.get_state(file_path) as PerFileState;
    expect(durable.scrollPosition).toEqual([{ top: 77, left: 0 }]);
    expect(durable.showFormatting).toEqual([false]);
    await vi.waitFor(() => {
        expect(snapshots_since(panel, from).length).toBeGreaterThan(intervening);
        expect(latest_snapshot(panel).state.scrollPosition).toEqual([{ top: 77, left: 0 }]);
        expect(latest_snapshot(panel).state.showFormatting).toEqual([false]);
    });
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: CONTENT.length, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode(CONTENT));
});

describe('a layout change waiting behind another layout write', () => {
    it('is kept when the editing state is announced meanwhile', async () => {
        // Starting to edit announces the claim to every window on the file,
        // and each one delivers its new capabilities.
        await expect_waiting_change_survives(async ({ panel }) => {
            void panel.__receive({ type: 'requestEditSession', requestId: 'owner' });
        });
    });

    it('is kept when a sort settles meanwhile and reconciles the stored view', async () => {
        // This window sorts descending. As that is stored, another window
        // stores an ascending sort. The request ends by reconciling what is
        // installed with what is stored, and delivers the view that results.
        const schema = '["Sheet1",1,["h"]]';
        const sort = (direction: 'asc' | 'desc') => ({
            sort: [{ colIndex: 0, direction }],
            filters: [],
            schema,
        });
        await expect_waiting_change_survives(async ({ panel, ready }) => {
            void panel.__receive({
                type: 'setTransform',
                sheetIndex: 0,
                requestId: 'sort',
                generation: ready.generation,
                sourceGeneration: ready.sourceGeneration,
                intent: 'user',
                state: sort('desc'),
            } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);
        }, async (next, versioned) => {
            if (next.transforms?.[0]?.sort?.[0]?.direction !== 'desc') return;
            const stored = await versioned.store.read(file_path);
            const peer = await versioned.store.compare_and_set(file_path, stored.revision, {
                ...(stored.state as PerFileState),
                transforms: [sort('asc')],
            });
            expect(peer.type).toBe('committed');
        });
    });

    it('is kept when an undo or redo finishes meanwhile', async () => {
        // A highlight-only replay: it needs no editing session, and its
        // terminal publishes the current material like any other.
        await expect_waiting_change_survives(async ({ panel }) => {
            await panel.__receive({
                type: 'prepareHistoryReplay',
                request: {
                    requestId: 'prepare',
                    replayId: 'replay',
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
            await vi.waitFor(() => expect(messages_of(panel, 'historyReplayPrepared')).toHaveLength(1));
            const prepared = messages_of(panel, 'historyReplayPrepared')[0].prepared;
            void panel.__receive({
                type: 'commitHistoryReplay',
                request: {
                    requestId: prepared.requestId,
                    replayId: prepared.replayId,
                    leaseId: prepared.leaseId,
                    mutationId: 'mutation',
                    cells: [],
                    highlights: [{ ordinal: 0 }],
                },
            } satisfies Extract<WebviewMessage, { type: 'commitHistoryReplay' }>);
            await vi.waitFor(() => expect(messages_of(panel, 'historyReplayCommitted')).toHaveLength(1));
        });
    });

    it('is kept when a Header Row answer is delivered meanwhile', async () => {
        // A .csv has no Header Row to change; the refusal is delivered in a
        // snapshot, as every Header Row answer is.
        await expect_waiting_change_survives(async ({ panel, ready }) => {
            void panel.__receive({
                type: 'setExcelFirstRowHeader',
                sheetIndex: 0,
                sheetName: 'Sheet1',
                enabled: false,
                requestId: 'header',
                generation: ready.generation,
                sourceGeneration: ready.sourceGeneration,
            } satisfies Extract<WebviewMessage, { type: 'setExcelFirstRowHeader' }>);
        });
    });
});

/** Any delivery from outside the layout queue: a refused Header Row change. */
async function deliver_from_outside(panel: Panel, basis: WorkbookSnapshot, request_id: string): Promise<void> {
    const before = messages_of(panel, 'workbookSnapshot').length;
    void panel.__receive({
        type: 'setExcelFirstRowHeader',
        sheetIndex: 0,
        sheetName: 'Sheet1',
        enabled: false,
        requestId: request_id,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
    } satisfies Extract<WebviewMessage, { type: 'setExcelFirstRowHeader' }>);
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length).toBeGreaterThan(before));
}

describe('what a queued layout change is a difference from', () => {
    it('stores the scroll back to the top after a scroll that landed under a delivery', async () => {
        // Two changes wait: A scrolls from 0 to 5, B scrolls back to 0. A
        // delivery arrives while they wait. A lands; had the state B is
        // compared with not moved to A's, B would look like no change at all
        // and the file would reopen at row 5.
        const context = await open_with_held_layout_write({ scrollPosition: [{ top: 0, left: 0 }] });
        const { panel, versioned, layout, first, release, ready } = context;
        const a = panel.__receive(layout({ scrollPosition: [{ top: 5, left: 0 }] }));
        const b = panel.__receive(layout({ scrollPosition: [{ top: 0, left: 0 }] }));
        await deliver_from_outside(panel, ready, 'between');

        release();
        await Promise.all([first, a, b]);

        expect((versioned.get_state(file_path) as PerFileState).scrollPosition).toEqual([{ top: 0, left: 0 }]);
        await vi.waitFor(() => expect(latest_snapshot(panel).state.scrollPosition)
            .toEqual([{ top: 0, left: 0 }]));
    });

    it('delivers a waiting change that another window had stored by the time its turn came', async () => {
        // The change waits; a delivery from before it arrives; another window
        // stores the very same scroll and formatting. The write then finds
        // nothing to change and commits nothing, but the window is still on
        // the delivery that lacks them, and has to be brought to what is stored.
        const context = await open_with_held_layout_write();
        const { panel, versioned, layout, first, release, ready } = context;
        const waiting = panel.__receive(layout(WAITING));
        await deliver_from_outside(panel, ready, 'between');
        const delivered = messages_of(panel, 'workbookSnapshot').length;
        const stored = await versioned.store.read(file_path);
        const peer = await versioned.store.compare_and_set(file_path, stored.revision, {
            ...(stored.state as PerFileState),
            ...WAITING,
        });
        expect(peer.type).toBe('committed');
        const revision = versioned.revision(file_path);

        release();
        await Promise.all([first, waiting]);

        // Nothing was written for it.
        expect(versioned.revision(file_path)).toBe(revision);
        await vi.waitFor(() => {
            expect(messages_of(panel, 'workbookSnapshot').length).toBeGreaterThan(delivered);
            expect(latest_snapshot(panel).state.scrollPosition).toEqual([{ top: 77, left: 0 }]);
            expect(latest_snapshot(panel).state.showFormatting).toEqual([false]);
        });
    });

    it('does not write again what an earlier change of the same snapshot already stored', async () => {
        const versioned = versioned_state_store();
        const panel = open_csv(with_in_memory_authority_transactions(versioned.store));
        const ready = await ready_and_acknowledged(panel);
        const layout = (state: PerFileState) => panel.__receive({
            type: 'stateChanged',
            sourceGeneration: ready.sourceGeneration,
            snapshotIdentity: ready.identity,
            state: { ...ready.state, ...state },
        });

        await layout({ showFormatting: [false] });
        expect((versioned.get_state(file_path) as PerFileState).showFormatting).toEqual([false]);
        // Another window turns formatting back on.
        const stored = await versioned.store.read(file_path);
        await versioned.store.compare_and_set(file_path, stored.revision, {
            ...(stored.state as PerFileState),
            showFormatting: [true],
        });
        // This window's next message still says "off", as its whole state
        // does, but the change it makes is the scroll.
        await layout({ showFormatting: [false], scrollPosition: [{ top: 9, left: 0 }] });

        const durable = versioned.get_state(file_path) as PerFileState;
        expect(durable.scrollPosition).toEqual([{ top: 9, left: 0 }]);
        expect(durable.showFormatting).toEqual([true]);
    });

    it('carries a change whose own write failed in the next message already waiting', async () => {
        // A turns formatting off; B, already queued, says that and a scroll.
        // A's store call throws. Nothing was stored for A, so B has to carry
        // both, with no third message from the window.
        const versioned = versioned_state_store();
        const reached = deferred();
        const fail = deferred();
        let throw_once = true;
        const queued = with_in_memory_authority_transactions(versioned.store);
        const panel = open_csv({
            ...queued,
            async compare_and_set(path, expected, next, validate, basis) {
                if (throw_once && next.showFormatting?.[0] === false) {
                    throw_once = false;
                    reached.resolve();
                    await fail.promise;
                    throw new Error('disk full');
                }
                return queued.compare_and_set(path, expected, next, validate, basis);
            },
        });
        const ready = await ready_and_acknowledged(panel);
        const layout = (state: PerFileState) => panel.__receive({
            type: 'stateChanged',
            sourceGeneration: ready.sourceGeneration,
            snapshotIdentity: ready.identity,
            state: { ...ready.state, ...state },
        });

        const a = layout({ showFormatting: [false] }).catch(() => undefined);
        await reached.promise;
        const b = layout({ showFormatting: [false], scrollPosition: [{ top: 9, left: 0 }] });
        fail.resolve();
        await Promise.all([a, b]);

        const durable = versioned.get_state(file_path) as PerFileState;
        expect(durable.showFormatting).toEqual([false]);
        expect(durable.scrollPosition).toEqual([{ top: 9, left: 0 }]);
    });

    it('does not apply a change that was queued before the file was reloaded', async () => {
        // Currency on the host's own terms is still asked when the write runs:
        // a change made on the old contents is not written onto the new ones.
        const context = await open_with_held_layout_write();
        const { panel, versioned, layout, first, release, ready } = context;
        const waiting = panel.__receive(layout(WAITING));

        const changed = 'h\nc\na\nb\nd\n';
        vscode_mock.__setReadFileImplementation(async () => enc.encode(changed));
        vscode_mock.__setStatImplementation(async () => ({ size: changed.length, mtime: 2 }));
        await vscode_mock.__getWatchers()[0].__fireChange();
        await vi.waitFor(() => expect(latest_snapshot(panel).sourceGeneration)
            .not.toBe(ready.sourceGeneration));

        release();
        // Both handlers have run to their end: nothing is still to be written.
        await Promise.all([first, waiting]);

        const durable = versioned.get_state(file_path) as PerFileState;
        expect(durable.scrollPosition).toEqual([{ top: 50, left: 0 }]);
        expect(durable.showFormatting).not.toEqual([false]);
    });
});
