import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import type { FileStateStore } from '../state';
import type { HostMessage, WebviewMessage } from '../types';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import { messages_of } from './helpers/panel-messages';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const file_path = '/tmp/history-replay-focus.csv';

/** Header plus four rows, so a hidden row leaves a non-identity mapping behind. */
const CONTENT = 'h\na\nb\nc\nd\n';

const SHEET = { sheetIndex: 0, sheetName: 'Sheet1' };

function open_csv_table(store: FileStateStore) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(store),
        csv_table_profile(),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

/**
 * Bring the panel up and acknowledge every snapshot it has posted.
 *
 * The acknowledgement is not ceremony: `acknowledged_current()` is a term of the
 * lease's own currency check, so an unacknowledged snapshot refuses every replay
 * as `document-changed` before any focus is resolved.
 */
async function ready(panel: ReturnType<typeof open_csv_table>): Promise<WorkbookSnapshot> {
    await panel.__receive({ type: 'ready' });
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length)
        .toBeGreaterThan(0));
    return await acknowledge_latest(panel);
}

async function acknowledge_latest(
    panel: ReturnType<typeof open_csv_table>,
): Promise<WorkbookSnapshot> {
    const latest = messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
    await panel.__receive({
        type: 'snapshotApplied',
        identity: latest.identity,
        disposition: 'applied',
    } satisfies Extract<WebviewMessage, { type: 'snapshotApplied' }>);
    return latest;
}

/**
 * Hide one display row, so source rows past it sit one row earlier.
 *
 * A transform installs a new VIEW without advancing `source_generation`, and the
 * lease binds the latter — so no snapshot is redelivered and none needs
 * re-acknowledging. That is exactly the case the display focus exists for: the
 * rows a replay addresses have not moved, but where they appear has.
 *
 * The basis is read from the latest snapshot at call time rather than passed in:
 * a replay's own durable write advances the view generation, so a basis captured
 * before one would be refused as stale — and a refusal installs nothing, which
 * would leave a caller asserting about a mapping that never moved.
 */
async function hide_display_row(
    panel: ReturnType<typeof open_csv_table>,
    display_row: number,
): Promise<void> {
    const basis = messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
    const request_id = `hide-${display_row}`;
    await panel.__receive({
        type: 'hideRows',
        sheetIndex: 0,
        displayRows: [{ start: display_row, end: display_row }],
        requestId: request_id,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
    } satisfies Extract<WebviewMessage, { type: 'hideRows' }>);
    await vi.waitFor(() => expect([
        ...messages_of(panel, 'transformInstalled'),
        ...messages_of(panel, 'transformRefused'),
    ].filter((message) => message.requestId === request_id)).toHaveLength(1));
    expect(messages_of(panel, 'transformRefused')
        .filter((message) => message.requestId === request_id)).toEqual([]);
}

/**
 * Run one highlight-only replay to completion and answer its commit.
 *
 * Highlight-only, deliberately: it needs no edit session, so the focus wiring can
 * be exercised without standing up an edit lifecycle that has nothing to do with
 * the coordinate mapping under test.
 */
let next_replay = 0;

async function replay_highlight(
    panel: ReturnType<typeof open_csv_table>,
    source_rows: readonly number[],
): Promise<Extract<HostMessage, { type: 'historyReplayCommitted' }>> {
    // Fresh correlation per call: the host retains a settled replay's answer so a
    // lost acknowledgement can be recovered, so reusing ids would have a second
    // replay's assertions matching the first one's retained record.
    const replay = `replay-${next_replay += 1}`;
    await panel.__receive({
        type: 'prepareHistoryReplay',
        request: {
            requestId: `req-${next_replay}`,
            replayId: replay,
            cells: [],
            highlights: source_rows.map((source_row, ordinal) => ({
                ordinal,
                worksheet: SHEET,
                sourceRow: source_row,
                sourceColumn: 0,
                expected: null,
                desired: 'yellow' as const,
            })),
            focus: {
                worksheet: SHEET,
                sourceRowStart: Math.min(...source_rows),
                sourceRowEnd: Math.max(...source_rows),
                sourceColumnStart: 0,
                sourceColumnEnd: 0,
            },
        },
    } satisfies Extract<WebviewMessage, { type: 'prepareHistoryReplay' }>);
    const prepared_answers = () => messages_of(panel, 'historyReplayPrepared')
        .filter((message) => message.prepared.replayId === replay);
    const prepare_refusals = () => messages_of(panel, 'historyReplayPrepareRefused')
        .filter((message) => message.refusal.replayId === replay);
    await vi.waitFor(() => expect(
        prepared_answers().length + prepare_refusals().length,
    ).toBe(1));
    expect(prepare_refusals()).toEqual([]);
    const prepared = prepared_answers()[0].prepared;

    await panel.__receive({
        type: 'commitHistoryReplay',
        request: {
            requestId: prepared.requestId,
            replayId: prepared.replayId,
            leaseId: prepared.leaseId,
            mutationId: `mutation-${next_replay}`,
            cells: [],
            highlights: source_rows.map((_row, ordinal) => ({ ordinal })),
        },
    } satisfies Extract<WebviewMessage, { type: 'commitHistoryReplay' }>);
    const commits = () => messages_of(panel, 'historyReplayCommitted')
        .filter((message) => message.committed.replayId === replay);
    const commit_refusals = () => messages_of(panel, 'historyReplayCommitRefused')
        .filter((message) => message.refusal.replayId === replay);
    await vi.waitFor(() => expect(commits().length + commit_refusals().length).toBe(1));
    expect(commit_refusals()).toEqual([]);
    return commits()[0];
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({
        size: enc.encode(CONTENT).byteLength,
        mtime: 1,
    }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode(CONTENT));
});

describe('the display focus a committed replay reports', () => {
    it('reports the source rows themselves when no transform is installed', async () => {
        const panel = open_csv_table(versioned_state_store().store);
        await ready(panel);

        const committed = await replay_highlight(panel, [1, 3]);

        expect(committed.committed.displayFocus).toEqual({
            displayRowStart: 1,
            displayRowEnd: 3,
            mappingGeneration: expect.any(Number),
        });
        expect(committed.committed.focus.sourceRowStart).toBe(1);
    });

    it('follows the installed view, so the cursor lands on the right row', async () => {
        // Display row 0 is hidden, so every later source row now sits one display
        // row earlier. Reporting the source interval would send the cursor a row
        // past what the replay actually touched.
        const panel = open_csv_table(versioned_state_store().store);
        await ready(panel);
        await hide_display_row(panel, 0);

        const committed = await replay_highlight(panel, [2, 3]);

        expect(committed.committed.focus.sourceRowStart).toBe(2);
        expect(committed.committed.displayFocus?.displayRowStart).toBe(1);
        expect(committed.committed.displayFocus?.displayRowEnd).toBe(2);
    });

    it('reports no display focus when the touched row is hidden', async () => {
        // The replay still succeeds — the highlight is written durably — but there
        // is nowhere truthful for the cursor to go, and `null` says so rather than
        // naming a row the replay did not touch.
        const panel = open_csv_table(versioned_state_store().store);
        await ready(panel);
        await hide_display_row(panel, 1);

        const committed = await replay_highlight(panel, [1]);

        expect(committed.committed.displayFocus).toBeNull();
        expect(committed.committed.focus.sourceRowStart).toBe(1);
    });

    it('stamps the mapping generation the projection was resolved against', async () => {
        // The stamp is what lets a renderer whose view has since moved decline to
        // select a row, instead of selecting the wrong one.
        const panel = open_csv_table(versioned_state_store().store);
        await ready(panel);
        const before = await replay_highlight(panel, [2]);
        await hide_display_row(panel, 0);
        // A different row, because the first replay left row 2 yellow and a second
        // one expecting no colour there is a conflict, not a stale mapping.
        const after = await replay_highlight(panel, [3]);

        expect(after.committed.displayFocus?.mappingGeneration)
            .toBeGreaterThan(before.committed.displayFocus!.mappingGeneration);
    });
});
