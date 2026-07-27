/**
 * The host's `setRowHeights` handler — the *sole* durable write path for custom row
 * heights now that the webview no longer holds or patches `PerFileState.rowHeights`.
 *
 * Modelled on `hide-rows-controller.test.ts`, which exercises the other webview→host
 * request that names rows in display space. The differences are that a resize carries no
 * `requestId` and is answered by no ack — it is acknowledged only by the delivery of a
 * new projection — so the observables here are the durable store, the delivered
 * `workbookSnapshot.rowHeightProjection`, and the owner-facing warning. Proving that a
 * refused request wrote *nothing* therefore needs a positive follow-up: refuse, then make
 * a request that must land, wait for it, and check only the second one is there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import type { FileStateStore } from '../state';
import {
    MAX_PERSISTED_ROW_HEIGHTS,
    type HostMessage,
    type StoredPerFileState,
    type WebviewMessage,
} from '../types';
import { MIN_ROW_HEIGHT_PX } from '../webview/row-heights';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const file_path = '/tmp/row-heights-controller.csv';

/** Header `h`, then data rows `c`, `a`, `b` at source rows 0, 1, 2. */
const CSV = 'h\nc\na\nb\n';

const ROW_HEIGHT_LIMIT_WARNING =
    'Too many resized rows to persist: a sheet may keep at most '
    + `${MAX_PERSISTED_ROW_HEIGHTS.toLocaleString('en-US')} custom row heights.`;

function open_csv_table(
    store: FileStateStore,
    profile: ViewerProfile = csv_table_profile(),
) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(store),
        profile,
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function messages_of<T extends HostMessage['type']>(
    panel: { __messages: unknown[] },
    type: T,
): Array<Extract<HostMessage, { type: T }>> {
    return panel.__messages.filter((message): message is Extract<HostMessage, { type: T }> => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === type
    ));
}

async function ready(panel: ReturnType<typeof open_csv_table>): Promise<WorkbookSnapshot> {
    await panel.__receive({ type: 'ready' });
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length)
        .toBeGreaterThan(0));
    return messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
}

function latest_projection(
    panel: ReturnType<typeof open_csv_table>,
): readonly (Readonly<Record<number, number>> | undefined)[] {
    return messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot.rowHeightProjection;
}

async function resize(
    panel: ReturnType<typeof open_csv_table>,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>,
    rows: Array<{ start: number; end: number }>,
    height: number,
): Promise<void> {
    await panel.__receive({
        type: 'setRowHeights',
        sheetIndex: 0,
        rows,
        height,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
    } satisfies Extract<WebviewMessage, { type: 'setRowHeights' }>);
}

/** Install an ascending sort, so display order (a, b, c) is source order (1, 2, 0). */
async function install_ascending_sort(
    panel: ReturnType<typeof open_csv_table>,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>,
): Promise<Extract<HostMessage, { type: 'transformInstalled' }>> {
    await panel.__receive({
        type: 'setTransform',
        sheetIndex: 0,
        requestId: 'sort-ascending',
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
        intent: 'user',
        state: {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["Sheet1",1,["h"]]',
        },
    } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);
    await vi.waitFor(() => expect(messages_of(panel, 'transformInstalled').length)
        .toBeGreaterThan(0));
    return messages_of(panel, 'transformInstalled').at(-1)!;
}

function warnings(): string[] {
    return vi.mocked(vscode_mock.window.showWarningMessage).mock.calls
        .map((call) => String(call[0]));
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vi.spyOn(vscode_mock.window, 'showWarningMessage');
    vscode_mock.__setStatImplementation(async () => ({ size: CSV.length, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode(CSV));
});

describe('the setRowHeights host handler', () => {
    it('writes the height against source rows, not the display rows requested', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const sorted = await install_ascending_sort(panel, initial);
        const basis = sorted.view.basis;

        // Display rows 0 and 1 under the ascending sort are `a` and `b`, i.e. source
        // rows 1 and 2. Nothing here is the identity: a display-keyed write would store
        // {0,1} and a later clear-the-sort would show the heights on the wrong rows.
        await resize(panel, basis, [{ start: 0, end: 1 }], 44);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 44, 2: 44 }));
    });

    it('delivers the re-projected heights back to the webview', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const sorted = await install_ascending_sort(panel, initial);
        const deliveries = messages_of(panel, 'workbookSnapshot').length;

        await resize(panel, sorted.view.basis, [{ start: 2, end: 2 }], 44);

        // `update_file_state` does not deliver on its own, so an explicit
        // `{ deliver: true }` is the only thing that makes the resize visible. Display
        // row 2 is `c`, source row 0 — durably stored as 0, delivered back as 2.
        await vi.waitFor(() => {
            expect(messages_of(panel, 'workbookSnapshot').length)
                .toBeGreaterThan(deliveries);
            expect(latest_projection(panel)).toEqual([{ 2: 44 }]);
        });
        expect(state.get_state(file_path).rowHeights?.[0]).toEqual({ 0: 44 });
    });

    it('projects durable heights on a profile that never builds an edit state', async () => {
        // The latch that feeds the projection sits *ahead* of the `file_edit_state`
        // guard in `observe_durable_state`, and it has to: that record exists only for
        // editing profiles, so behind the guard Excel would observe heights exactly
        // never and every projection would be permanently empty.
        const state = versioned_state_store({
            rowHeights: [{ 2: 41 }],
        } as StoredPerFileState);
        const panel = open_csv_table(state.store, {
            ...csv_table_profile(),
            editing: false,
        });

        const initial = await ready(panel);

        expect(initial.rowHeightProjection).toEqual([{ 2: 41 }]);
    });

    it('clamps a height below the floor before anything durable is written', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);

        await resize(panel, initial, [{ start: 0, end: 0 }], 1);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: MIN_ROW_HEIGHT_PX }));
    });

    it('ignores a stale generation, writing nothing and replaying nothing', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await resize(
            panel,
            { ...initial, generation: initial.generation + 1 },
            [{ start: 0, end: 0 }],
            44,
        );
        // A later, current request is what proves the stale one wrote nothing rather
        // than merely not having got there yet — and that nothing was queued for replay.
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
        // Silent: no refusal message, and no warning either.
        expect(warnings()).toEqual([]);
    });

    it('ignores a stale source generation', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await resize(
            panel,
            { ...initial, sourceGeneration: initial.sourceGeneration + 1 },
            [{ start: 0, end: 0 }],
            44,
        );
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
    });

    it('refuses a request naming more rows than a sheet may keep, and says so', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        // Counted off the intervals *before* mapping: `map_display_rows_to_source`
        // allocates two `Uint32Array`s the size of the request, so a select-all on a
        // huge sheet has already cost the memory by the time a post-mapping check runs.
        await resize(
            panel,
            initial,
            [{ start: 0, end: MAX_PERSISTED_ROW_HEIGHTS }],
            44,
        );

        await vi.waitFor(() => expect(warnings()).toEqual([ROW_HEIGHT_LIMIT_WARNING]));
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
    });

    it('refuses when the accumulated map would pass the bound, and warns once', async () => {
        // Rows this three-row sheet does not have, so the request below adds an entry
        // rather than overwriting one. This is the refusal a user reaches by a hundred
        // small drags: the webview never holds the durable map and cannot predict it.
        const seeded: Record<number, number> = {};
        for (let row = 10; row < 10 + MAX_PERSISTED_ROW_HEIGHTS; row += 1) {
            seeded[row] = 30;
        }
        const state = versioned_state_store({
            rowHeights: [seeded],
        } as StoredPerFileState);
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await resize(panel, initial, [{ start: 0, end: 0 }], 44);

        // Raised after the write settles rather than inside the updater, which re-runs
        // once per losing CAS — so exactly one warning, whatever the store does.
        await vi.waitFor(() => expect(warnings()).toEqual([ROW_HEIGHT_LIMIT_WARNING]));
        // All-or-nothing: the refused row is absent and the seeded map is intact.
        expect(state.get_state(file_path).rowHeights?.[0]).toEqual(seeded);
        expect(state.revision(file_path)).toBe(revision);
    });

    it('accepts a request that fills the bound exactly', async () => {
        // The boundary on the other side, so the comparison cannot be off by one.
        const seeded: Record<number, number> = {};
        for (let row = 10; row < 9 + MAX_PERSISTED_ROW_HEIGHTS; row += 1) {
            seeded[row] = 30;
        }
        const state = versioned_state_store({
            rowHeights: [seeded],
        } as StoredPerFileState);
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);

        await resize(panel, initial, [{ start: 0, end: 0 }], 44);

        await vi.waitFor(() => expect(
            Object.keys(state.get_state(file_path).rowHeights?.[0] ?? {}),
        ).toHaveLength(MAX_PERSISTED_ROW_HEIGHTS));
        expect(state.get_state(file_path).rowHeights?.[0]?.[0]).toBe(44);
        expect(warnings()).toEqual([]);
    });

    it('drops an interval the installed view does not contain, without warning', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        // `map_display_rows_to_source` throws a RangeError past the end of the view.
        // On a current generation that is a malformed request, not a stale one; there
        // is nothing to write and nothing to tell the user.
        await resize(panel, initial, [{ start: 1, end: 9 }], 44);
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
        expect(warnings()).toEqual([]);
    });

    it('writes nothing when the rows already have the requested height', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        await resize(panel, initial, [{ start: 0, end: 0 }], 44);
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: 44 }));
        const revision = state.revision(file_path);
        const deliveries = messages_of(panel, 'workbookSnapshot').length;

        // A drag that ends where it started reports its final size like any other.
        await resize(panel, initial, [{ start: 0, end: 0 }], 44);
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: 44, 1: 55 }));
        // One revision and one delivery for the second request, none for the no-op.
        expect(state.revision(file_path)).toBe(revision + 1);
        expect(messages_of(panel, 'workbookSnapshot').length).toBe(deliveries + 1);
    });

    it('rejects a malformed interval and a non-finite height', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await resize(panel, initial, [{ start: 2, end: 0 }], 44);
        await resize(panel, initial, [{ start: 0.5, end: 1 }], 44);
        await resize(panel, initial, [], 44);
        await resize(panel, initial, [{ start: 0, end: 0 }], Number.NaN);
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
        expect(warnings()).toEqual([]);
    });

    it('writes nothing in preview mode', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store, {
            ...csv_table_profile(),
            previewMode: true,
        });
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await resize(panel, initial, [{ start: 0, end: 0 }], 44);

        // Nothing to wait for, so this is asserted after a turn of the microtask queue
        // that a landing write would have needed anyway.
        await Promise.resolve();
        expect(state.revision(file_path)).toBe(revision);
        expect(state.get_state(file_path).rowHeights).toBeUndefined();
    });

    it('ignores a sheet index the workbook does not have', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await panel.__receive({
            type: 'setRowHeights',
            sheetIndex: 4,
            rows: [{ start: 0, end: 0 }],
            height: 44,
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        } satisfies Extract<WebviewMessage, { type: 'setRowHeights' }>);
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
    });
});
