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
    transform_schema_for_sheet,
    type HostMessage,
    type StoredPerFileState,
    type WebviewMessage,
} from '../types';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import { MAX_ROW_HEIGHT_PX, MIN_ROW_HEIGHT_PX } from '../webview/row-heights';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import {
    acquire_file_coordinator,
    type FileCoordinatorAttachment,
} from '../file-coordinator';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const file_path = '/tmp/row-heights-controller.csv';

/** Header `h`, then data rows `c`, `a`, `b` at source rows 0, 1, 2. */
const CSV = 'h\nc\na\nb\n';

/**
 * What the mock filesystem currently holds. Mutable so one test can change the file
 * *content* under a watcher event, which is what advances the coordinator's file
 * authority — a same-digest refresh does not.
 */
let disk = CSV;

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
    await resize_sheet(panel, basis, 0, rows, height);
}

/** `resize`, for the multi-sheet fixture where the sheet index is the point. */
async function resize_sheet(
    panel: ReturnType<typeof open_csv_table>,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>,
    sheetIndex: number,
    rows: Array<{ start: number; end: number }>,
    height: number,
): Promise<void> {
    await panel.__receive({
        type: 'setRowHeights',
        sheetIndex,
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
    disk = CSV;
    vscode_mock.__setStatImplementation(async () => ({ size: disk.length, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode(disk));
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

    it('clamps a height above the ceiling before anything durable is written', async () => {
        // The floor's counterpart, and not merely for symmetry. Persisted unclamped, a row
        // taller than any viewport leaves the user no bottom edge on screen to drag it back
        // by — and the value is reachable without a malformed message, because multiline
        // auto-grow derives a height from the number of hard newlines in a cell and that is
        // unbounded. Clamped host-side as well as in the webview, since the host is the
        // only writer and is what a future webview build would be measured against.
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);

        await resize(panel, initial, [{ start: 0, end: 0 }], 1e12);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: MAX_ROW_HEIGHT_PX }));
        await vi.waitFor(() => expect(latest_projection(panel))
            .toEqual([{ 0: MAX_ROW_HEIGHT_PX }]));
    });

    it('refuses a generation older than this sheet\'s own mapping generation', async () => {
        // The refusal that survives scoping currency per sheet, and the direction that
        // matters: a display row from before *this* sheet was permuted names a different
        // source row now, so honouring the request would resize whatever row has since
        // moved into that position. Nothing is replayed either — a replay would do exactly
        // that damage one beat later.
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const sorted = await install_ascending_sort(panel, initial);
        const revision = state.revision(file_path);

        // Display row 0 pre-sort is source row 0 (`c`); post-sort it is source row 1
        // (`a`). The two answers differ, which is what makes the refusal observable.
        await resize(panel, initial, [{ start: 0, end: 0 }], 44);
        // A current request proves the stale one wrote nothing rather than merely not
        // having arrived yet, and that nothing was queued behind it.
        await resize(panel, sorted.view.basis, [{ start: 0, end: 0 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
        expect(warnings()).toEqual([]);
    });

    it('ignores a generation the core has never issued, writing nothing', async () => {
        // The upper bound of the accepted range. Unreachable from an honest webview — it
        // only ever posts a generation the host gave it — but it is what keeps "at least
        // this sheet's mapping generation" from degenerating into "any number at all" on a
        // sheet that has never been permuted, whose mapping generation is the floor.
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

        // A drag that ends where it started reports its final size like any other.
        await resize(panel, initial, [{ start: 0, end: 0 }], 44);
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: 44, 1: 55 }));
        // One revision for the second request, none for the no-op.
        expect(state.revision(file_path)).toBe(revision + 1);
    });

    it('acknowledges a no-op resize with the freshly read projection', async () => {
        // A no-op is a *success* that writes nothing, and silence is not an acceptable
        // answer to it. The webview has already appended an optimistic layer, and a layer
        // is only dropped by a delivered projection that agrees with it
        // (`row_height_layers_for_delivery`) — so an unanswered no-op leaves the layer
        // masking whatever the projection later says, for the rest of the generation.
        //
        // Not a hypothetical, because "the height is already durable" is exactly what a
        // sibling panel's write makes true behind this panel's back: durable heights move
        // with no generation bump, so this panel can be holding a stale projection while
        // the user drags a row to precisely the value another panel just persisted.
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        // Written straight into durable state rather than through this panel, which is
        // what makes the resize below a no-op *against a projection this panel has never
        // been delivered* — the sibling-write shape, not a repeat of its own drag.
        const committed = await state.store.compare_and_set(
            file_path,
            state.revision(file_path),
            { ...state.get_state(file_path), rowHeights: [{ 1: 44 }] },
        );
        expect(committed.type).toBe('committed');
        const revision = state.revision(file_path);
        const deliveries = messages_of(panel, 'workbookSnapshot').length;
        expect(latest_projection(panel)).toEqual([undefined]);

        await resize(panel, initial, [{ start: 1, end: 1 }], 44);

        // A delivery, carrying the height the file already held — which is what lets the
        // webview retire its layer — and no durable write.
        await vi.waitFor(() => {
            expect(messages_of(panel, 'workbookSnapshot').length)
                .toBeGreaterThan(deliveries);
            expect(latest_projection(panel)).toEqual([{ 1: 44 }]);
        });
        expect(state.revision(file_path)).toBe(revision);
    });

    it('does not acknowledge a refusal, only a no-op success', async () => {
        // The distinction the no-op acknowledgement must not blur. A write refused on the
        // accumulated-map bound also returns no committed snapshot, and it must stay
        // unanswered: nothing was persisted, so no projection could agree with the layer,
        // and the deliberate residue is that the layer stands until the generation moves
        // (reasoned out in full at `row_height_layers_for_delivery`). Acknowledging it
        // would deliver a projection that *disagrees*, which is the one thing the webview
        // reads as "not yet answered" and would leave the layer in place anyway — while
        // costing a delivery per refused drag.
        const seeded: Record<number, number> = {};
        for (let row = 10; row < 10 + MAX_PERSISTED_ROW_HEIGHTS + 50; row += 1) {
            seeded[row] = 30;
        }
        const state = versioned_state_store({
            rowHeights: [seeded],
        } as StoredPerFileState);
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const deliveries = messages_of(panel, 'workbookSnapshot').length;

        await resize(panel, initial, [{ start: 0, end: 0 }], 44);

        await vi.waitFor(() => expect(warnings()).toEqual([ROW_HEIGHT_LIMIT_WARNING]));
        expect(messages_of(panel, 'workbookSnapshot').length).toBe(deliveries);
    });

    it('rejects a malformed interval and a non-finite height', async () => {
        // The interval half is held jointly with `map_display_rows_to_source`, which
        // validates the same shapes and throws. Probing found the handler's own guards
        // survive their removal one at a time because the mapper still refuses, and this
        // fails only when both are gone — so what is pinned is that a malformed request
        // writes nothing, not which of the two defences refuses it. The handler keeps its
        // copy because it runs *before* the mapper allocates two `Uint32Array`s the size
        // of the request, and because a descending interval otherwise subtracts from the
        // pre-mapping row count.
        //
        // An empty `rows` array is deliberately not among the cases below: it is
        // unfalsifiable. No entry is written for it whatever the guards do, so an
        // assertion about it would pass with every implementation.
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await resize(panel, initial, [{ start: 2, end: 0 }], 44);
        await resize(panel, initial, [{ start: 0.5, end: 1 }], 44);
        await resize(panel, initial, [{ start: 0, end: 0 }], Number.NaN);
        await resize(panel, initial, [{ start: 1, end: 1 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(state.revision(file_path)).toBe(revision + 1);
        expect(warnings()).toEqual([]);
    });

    it('persists a resize in preview mode, like every other layout field', async () => {
        // Preview refuses `hideRows` because that is a *view transform*: it changes which
        // rows the view contains, which is a claim about the document a read-only preview
        // has no business making. A height changes nothing about row identity — it is
        // layout, in the same class as `columnWidths` and `scrollPosition`, which preview
        // has always persisted through `stateChanged`. Refusing here would also have been
        // silent: preview still mounts the resize overlay and still paints the new height,
        // so the row would look resized until a later delivery quietly reverted it.
        const state = versioned_state_store();
        const panel = open_csv_table(state.store, {
            ...csv_table_profile(),
            previewMode: true,
        });
        const initial = await ready(panel);
        expect(initial.configuration.previewMode).toBe(true);

        await resize(panel, initial, [{ start: 0, end: 0 }], 44);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: 44 }));
        await vi.waitFor(() => expect(latest_projection(panel)).toEqual([{ 0: 44 }]));
    });

    it('projects a legacy height map that is still keyed by sheet name', async () => {
        // `LegacyPerFileState` keys every per-sheet map by sheet *name*. Latched through
        // unconverted, the projection's index lookup gets `undefined` and every height the
        // user persisted under an older version silently disappears on open — and stays
        // gone, because an unchanged state is not necessarily rewritten, so nothing later
        // restores what the first read failed to see.
        const state = versioned_state_store({
            rowHeights: { Sheet1: { 2: 41 } },
        } as StoredPerFileState);
        const panel = open_csv_table(state.store);

        const initial = await ready(panel);

        expect(initial.rowHeightProjection).toEqual([{ 2: 41 }]);
    });

    it('changes a row already in an over-cap map without refusing it', async () => {
        // Releases before `MAX_PERSISTED_ROW_HEIGHTS` existed could persist a select-all
        // height map, so a file on disk may already hold far more than the cap. A check on
        // the resulting *level* would then refuse every resize on that file forever, with
        // no way out: the webview never sees the durable map, so nothing tells the user to
        // delete entries and there is no UI to delete them with. Checking growth still
        // stops any over-cap map being created or grown, which is all the bound was for.
        const seeded: Record<number, number> = {};
        for (let row = 0; row < MAX_PERSISTED_ROW_HEIGHTS + 50; row += 1) seeded[row] = 30;
        const state = versioned_state_store({
            rowHeights: [seeded],
        } as StoredPerFileState);
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);

        // Display row 0 is source row 0, which the seeded map already names — so the write
        // changes a value and adds no key.
        await resize(panel, initial, [{ start: 0, end: 0 }], 44);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0]?.[0])
            .toBe(44));
        expect(Object.keys(state.get_state(file_path).rowHeights?.[0] ?? {}))
            .toHaveLength(MAX_PERSISTED_ROW_HEIGHTS + 50);
        expect(warnings()).toEqual([]);
    });

    it('still refuses to grow an over-cap map, and says so', async () => {
        // The boundary the growth check must not have moved: a row the map does *not*
        // already name adds a key, and that is the write the bound exists to stop.
        const seeded: Record<number, number> = {};
        for (let row = 10; row < 10 + MAX_PERSISTED_ROW_HEIGHTS + 50; row += 1) {
            seeded[row] = 30;
        }
        const state = versioned_state_store({
            rowHeights: [seeded],
        } as StoredPerFileState);
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await resize(panel, initial, [{ start: 0, end: 0 }], 44);

        await vi.waitFor(() => expect(warnings()).toEqual([ROW_HEIGHT_LIMIT_WARNING]));
        expect(state.get_state(file_path).rowHeights?.[0]).toEqual(seeded);
        expect(state.revision(file_path)).toBe(revision);
    });

    it('refuses a resize whose file authority has moved on, generations notwithstanding', async () => {
        // The window the generation pair cannot see. During a physical refresh the
        // coordinator's file authority advances *before* the new source is adopted, and the
        // editable profile's `read_file_state()` await widens the gap — so the old core's
        // `generation` and `sourceGeneration` both still match a request that was mapped
        // through the *old* source. Writing it lands a height on a row of the new file
        // revision the user never touched: a silent mis-attribution, which is worse than
        // losing the resize.
        //
        // Reproduced by parking the first durable state read taken *after* the authority
        // advanced — empirically the read inside the adoption path — and posting the resize
        // while the refresh sits there. The resize's own read is not parked, so the refusal
        // is the predicate's and not a side effect of the stall.
        const state = versioned_state_store();
        let coordinator: FileCoordinatorAttachment | undefined;
        let park_at_authority: number | undefined;
        let parked: (() => void) | undefined;
        const store: FileStateStore = {
            ...state.store,
            async read(path) {
                if (
                    park_at_authority !== undefined
                    && coordinator?.authority().authorityRevision === park_at_authority
                ) {
                    park_at_authority = undefined;
                    await new Promise<void>((resume) => { parked = resume; });
                }
                return state.store.read(path);
            },
        };
        const panel = open_csv_table(store);
        const initial = await ready(panel);
        // Acquired only after `attach_viewer`, so the coordinator entry is the one the
        // controller built with the fake host's watcher factory. Released in `finally`:
        // this extra attachment keeps the entry — and its advanced authority — alive, so
        // leaking it on a failure would break every later test in the file rather than
        // just this one.
        coordinator = acquire_file_coordinator(file_path);
        try {
            expect(coordinator.authority().authorityRevision).toBe(1);

            park_at_authority = 2;
            disk = 'h\nc\na\nb\nz\n';
            const refresh = vscode_mock.__getActiveWatchers()[0].__fireChange();
            await vi.waitFor(() => expect(parked).toBeDefined());
            expect(coordinator.authority().authorityRevision).toBe(2);
            // No delivery yet, so the core has not adopted and the generations the webview
            // holds — the ones `initial` carries — are still the core's own. That is
            // precisely what makes the generation pair useless here.
            expect(messages_of(panel, 'workbookSnapshot')).toHaveLength(1);

            await resize(panel, initial, [{ start: 0, end: 0 }], 44);

            expect(state.get_state(file_path).rowHeights).toBeUndefined();
            parked!();
            await refresh;
            expect(state.get_state(file_path).rowHeights).toBeUndefined();
        } finally {
            parked?.();
            coordinator.dispose();
        }
    });

    it('answers a resize refused during an authority finalization', async () => {
        // The refusal above is self-healing by construction: the *source* is being
        // replaced, so the delivery that adopts it voids the webview's whole overlay
        // (`retained_row_height_overlay`) and the optimistic layer goes with it.
        //
        // This covers the case where that argument is unavailable. A CSV save takes an
        // authority turn, and `state_write_is_current` is false while that turn is
        // `finalizing`, so a resize arriving inside the window is refused — correctly, and
        // not newly: every durable layout write refuses there, which predates this PR.
        // What is new is the optimistic layer, which is retired only by a delivery that
        // disagrees with it or by the view generation moving. Neither is guaranteed by the
        // refusal itself, so "the write is dropped" and "the row keeps a height no file
        // holds" are separate questions and only the second one is user-visible.
        //
        // Reviewed as a suspected stranding, and it is not one: the save path delivers
        // while the window is open, so the layer is answered without the handler doing
        // anything. A refusal-delivery branch was written for it and reverted — it added a
        // seventh delivery to six that already arrive, and no test could distinguish it,
        // which makes it unfalsifiable code on a hot path rather than a fix. This test is
        // what records that, so the next reviewer to notice the same window has the
        // measurement instead of the suspicion.
        //
        // Asserted on the delivery rather than the durable store, because the store alone
        // cannot tell a refusal that answers the webview from one that abandons it.
        const state = versioned_state_store();
        let coordinator: FileCoordinatorAttachment | undefined;
        let park_when_finalizing = false;
        let parked: (() => void) | undefined;
        const store: FileStateStore = {
            ...state.store,
            async read(path) {
                // Gated on the phase itself rather than on a guessed revision: the turn
                // is what this test needs to sit inside, and `state_write_is_current`
                // going false for the *current* authority is exactly "a turn is
                // finalizing" — the same predicate the resize handler consults.
                if (
                    park_when_finalizing
                    && coordinator !== undefined
                    && !coordinator.state_write_is_current(
                        coordinator.authority().authorityRevision,
                    )
                ) {
                    park_when_finalizing = false;
                    await new Promise<void>((resume) => { parked = resume; });
                }
                return state.store.read(path);
            },
        };
        const panel = open_csv_table(store);
        const initial = await ready(panel);
        coordinator = acquire_file_coordinator(file_path);
        let save: Promise<unknown> | undefined;
        try {
            const deliveries_before = messages_of(panel, 'workbookSnapshot').length;
            // A CSV save takes an authority turn and calls `start_finalization` before
            // awaiting `finalize_authority`, which reads state — so parking that read
            // holds the turn in `finalizing`, which is the window. The save rewrites the
            // file, but the source is not replaced until it completes, so while we are
            // parked the view has not moved and the webview's generations still match.
            await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
            const edit_session_id = messages_of(panel, 'editSessionResult')
                .at(-1)!.editSessionId!;
            park_when_finalizing = true;
            save = panel.__receive({
                type: 'saveCsv',
                operation: {
                    editSessionId: edit_session_id,
                    saveRequestId: 'save',
                    edits: { '0:0': 'z' },
                    dirtyEdits: { '0:0': { value: 'z', base: 'c' } },
                },
            });
            await vi.waitFor(() => expect(parked).toBeDefined());

            await resize(panel, initial, [{ start: 0, end: 0 }], 44);

            // Refused, as every durable layout write is during finalization. The save's
            // own write has already put an empty per-sheet slot there; what matters is
            // that no height was recorded in it.
            expect(state.get_state(file_path).rowHeights?.[0]).toBeUndefined();
            // And answered: a delivery the webview can reconcile its layer against,
            // carrying a projection without the refused height. Without this the layer
            // has nothing to retire it — the save's own commit updates session state but
            // does not deliver, and the view generation never moves.
            const answers = messages_of(panel, 'workbookSnapshot')
                .slice(deliveries_before);
            expect(answers.length).toBeGreaterThan(0);
            expect(answers.at(-1)!.snapshot.rowHeightProjection[0]).toBeUndefined();

            parked!();
            await save;
            expect(state.get_state(file_path).rowHeights?.[0]).toBeUndefined();
        } finally {
            parked?.();
            // Awaited here as well as in the body: an assertion that throws above skips
            // the `await save`, and the save would then reject into no one — Vitest
            // reports that as an unhandled error and it buries the real failure.
            await save?.catch(() => {});
            coordinator.dispose();
        }
    });

    // No test for "ignores a sheet index the workbook does not have". The handler's guard
    // was probed by deleting it, then by deleting the `RangeError` in
    // `map_display_rows_to_source` beside it, then by making the row count tolerate a
    // missing sheet as well — and nothing failed at any step, because the sheet lookup
    // inside `read_source_row_indices` still refuses and the handler's `catch` returns.
    // There is no reachable variant in which a bogus sheet index writes anything, so a
    // test asserting that it does not would pass with every implementation. The guard
    // stays as the cheapest of the three refusals; `map_display_rows_to_source`'s own
    // range test is where the behaviour is covered.
});

/**
 * A workbook with two sheets, which is the only shape in which the question can be asked
 * at all: the generation is core-wide but a permutation is per sheet, so telling "the view
 * moved" from "this sheet's view moved" needs a second sheet to move instead. CSV is
 * always one sheet, hence a bare multi-sheet `DataSource` behind a minimal profile rather
 * than `csv_table_profile`.
 */
class TwoSheetSource implements DataSource {
    private readonly rows: Record<number, string[]> = {
        0: ['c', 'a', 'b'],
        1: ['q', 'p', 'r'],
    };

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [0, 1].map((sheet) => ({
                name: `Sheet${sheet + 1}`,
                rowCount: this.rows[sheet].length,
                sourceRowCount: this.rows[sheet].length,
                columnCount: 1,
                merges: [],
                hasFormatting: false,
            })),
        };
    }

    read_rows(sheet: number, start: number, count: number): RowWindow {
        const values = this.rows[sheet] ?? [];
        const clamped = Math.max(0, Math.min(start, values.length));
        const rows: (RenderedCell | null)[][] = values
            .slice(clamped, clamped + count)
            .map((raw) => [{ raw, formatted: raw, bold: false, italic: false }]);
        return { startRow: clamped, rows };
    }

    close(): void {}
}

function open_two_sheet_workbook(store: FileStateStore) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(store),
        { editing: false, async build_source() { return new TwoSheetSource(); } },
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

/** Sort one sheet ascending on its only column, and return the ack it installed. */
async function sort_sheet_ascending(
    panel: ReturnType<typeof open_two_sheet_workbook>,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration' | 'meta'>,
    sheetIndex: number,
): Promise<Extract<HostMessage, { type: 'transformInstalled' }>> {
    const requestId = `sort-${sheetIndex}-${basis.generation}`;
    await panel.__receive({
        type: 'setTransform',
        sheetIndex,
        requestId,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
        intent: 'user',
        state: {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: transform_schema_for_sheet(basis.meta.sheets[sheetIndex]),
        },
    } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);
    const acks = () => messages_of(panel, 'transformInstalled')
        .filter((message) => message.requestId === requestId);
    await vi.waitFor(() => expect(acks()).toHaveLength(1));
    return acks()[0];
}

describe('setRowHeights currency across sheets', () => {
    it('accepts a resize for a sheet whose mapping never moved, though the generation has', async () => {
        // The bug this pins: `generation` is one counter for the whole core, so a transform
        // finishing on *another* sheet — a saved transform restoring on a background sheet,
        // or a long sort the user kicked off before switching tabs — used to reject a resize
        // on the sheet in front of them, whose display→source mapping had not moved a row.
        // The user saw the row silently spring back, with no message and nothing to retry
        // but the drag.
        const state = versioned_state_store();
        const panel = open_two_sheet_workbook(state.store);
        const initial = await ready(panel);
        expect(initial.meta.sheets).toHaveLength(2);

        // Sheet 0 is permuted first, so the accepted request below has to be mapped through
        // a real permutation rather than through the identity — otherwise the test would
        // pass on a handler that ignored the mapping entirely.
        const sheet_0_sorted = await sort_sheet_ascending(panel, initial, 0);
        const sheet_0_basis = sheet_0_sorted.view.basis;
        // Then sheet 1 moves, bumping the shared generation past what a webview looking at
        // sheet 0 holds. Sheet 0's own arrangement is untouched.
        const sheet_1_sorted = await sort_sheet_ascending(
            panel,
            { ...initial, generation: sheet_0_basis.generation },
            1,
        );
        expect(sheet_1_sorted.view.basis.generation)
            .toBeGreaterThan(sheet_0_basis.generation);

        await resize(panel, sheet_0_basis, [{ start: 0, end: 1 }], 44);

        // Accepted, and mapped through sheet 0's ascending sort: display rows 0 and 1 are
        // `a` and `b`, source rows 1 and 2. A handler that had refused writes nothing; one
        // that accepted but ignored the permutation would write {0, 1}.
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 44, 2: 44 }));
        expect(warnings()).toEqual([]);
    });

    it('refuses a resize for the sheet that moved, in the same run of generations', async () => {
        // The other half, on the same fixture, because scoping currency per sheet is only
        // worth anything if it still refuses what it always refused. Same two installs,
        // same stale generation — the request just names the sheet that was permuted after
        // it, and that one must die.
        const state = versioned_state_store();
        const panel = open_two_sheet_workbook(state.store);
        const initial = await ready(panel);

        const sheet_0_sorted = await sort_sheet_ascending(panel, initial, 0);
        const sheet_0_basis = sheet_0_sorted.view.basis;
        const sheet_1_sorted = await sort_sheet_ascending(
            panel,
            { ...initial, generation: sheet_0_basis.generation },
            1,
        );

        // `sheet_0_basis.generation` predates sheet 1's install, so for sheet 1 it names an
        // arrangement that no longer exists. Deliberately naming a *different* display row
        // from the request below: judged against the wrong sheet's mapping generation this
        // would be accepted, and it has to leave a key behind that the surviving state can
        // be distinguished by. (Display row 2 of the sorted sheet 1 is `r`, source row 2.)
        await resize_sheet(panel, sheet_0_basis, 1, [{ start: 2, end: 2 }], 44);
        // A current request for the same sheet proves the refused one wrote nothing and was
        // not queued: display rows 0 and 1 of the sorted sheet 1 are `p` and `q`, source
        // rows 1 and 0.
        await resize_sheet(
            panel,
            sheet_1_sorted.view.basis,
            1,
            [{ start: 0, end: 1 }],
            55,
        );

        // Exactly these two keys: an accepted stale request would have added source row 2.
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[1])
            .toEqual({ 0: 55, 1: 55 }));
        expect(state.get_state(file_path).rowHeights?.[0]).toBeUndefined();
        expect(warnings()).toEqual([]);
    });

    it('keeps an untouched sheet\'s projection across a sibling sheet\'s write', async () => {
        // The core memoizes each sheet's projection against that sheet's mapping
        // generation and the *identity* of its durable height map. Identity is the only
        // per-sheet fact available — the durable `revision` is file-wide — and it is only
        // a fact if the latch preserves it, because the store structured-clones state on
        // every read and every CAS commit. Without that, a snapshot brings fresh map
        // objects for sheets nothing touched, the identity check misses, and a pre-cap
        // legacy map with millions of entries is walked and reallocated during a sibling
        // sheet's resize — the exact cost the memo exists to remove.
        //
        // Asserted through the delivered projection's object identity rather than by
        // counting recomputations, because identity is what the memo actually promises
        // and what the delivery path shares by reference. It is also the observable a
        // test backed by a non-cloning store could not distinguish, which is how this
        // shipped green the first time.
        const state = versioned_state_store();
        const panel = open_two_sheet_workbook(state.store);
        const initial = await ready(panel);

        await resize_sheet(panel, initial, 0, [{ start: 0, end: 0 }], 44);
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: 44 }));
        const projection_of = () => messages_of(panel, 'workbookSnapshot')
            .at(-1)!.snapshot.rowHeightProjection;
        const sheet_0_before = projection_of()[0];
        expect(sheet_0_before).toEqual({ 0: 44 });

        // A write to the *other* sheet: same file, new revision, cloned state on the way
        // back in. Sheet 0's heights did not move.
        const basis = messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
        await resize_sheet(panel, basis, 1, [{ start: 0, end: 0 }], 55);
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[1])
            .toEqual({ 0: 55 }));

        await vi.waitFor(() => expect(projection_of()[1]).toEqual({ 0: 55 }));
        // Sheet 0 was neither recomputed nor reallocated.
        expect(projection_of()[0]).toBe(sheet_0_before);
        expect(warnings()).toEqual([]);
    });

    it('reprojects a sheet that gained a height rather than retaining the old map', async () => {
        // The other side of the retention, and the one where a mistake is silent rather
        // than merely slow. Retention is by content, and the subset case is the one an
        // entry-by-entry comparison gets wrong without a count: every entry of the old
        // map is still present and unchanged, so a check that only walked the old map's
        // keys would call the two equal and keep serving a projection that is missing the
        // row the user just resized. The height would simply never appear.
        const state = versioned_state_store();
        const panel = open_two_sheet_workbook(state.store);
        const initial = await ready(panel);

        await resize_sheet(panel, initial, 0, [{ start: 0, end: 0 }], 44);
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: 44 }));

        // A strict superset: row 0 keeps the height it had, row 1 is added.
        const basis = messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
        await resize_sheet(panel, basis, 0, [{ start: 1, end: 1 }], 44);
        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 0: 44, 1: 44 }));

        await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot')
            .at(-1)!.snapshot.rowHeightProjection[0]).toEqual({ 0: 44, 1: 44 }));
        expect(warnings()).toEqual([]);
    });

    it('abandons a resize whose sheet is permuted while its durable read is in flight', async () => {
        // The two cases above both decide currency *before* the handler awaits anything,
        // so they are answered by the first of its four checks and pass with the other
        // three deleted — mutation testing is how that was found. This is the case that
        // separates them: the request is current when it is admitted and stops being
        // current part-way through, which is reachable precisely because the write path
        // is asynchronous (a durable read, a serialized layout-write tail, then a CAS
        // that re-runs its updater on conflict).
        //
        // The window is opened by the store rather than by a fake timer: the handler
        // awaits `read`, so installing a sort from inside one lands the permutation
        // between the admission check and the write, which is the real interleaving
        // rather than a simulation of one. A resize honoured here would map display rows
        // through a mapping the request never saw, and paint the height on rows the user
        // did not drag — the exact silent-corruption failure the fences exist to stop.
        const state = versioned_state_store();
        let intercept: (() => Promise<void>) | undefined;
        const gated_store: FileStateStore = {
            ...state.store,
            async read(path) {
                const pending = intercept;
                intercept = undefined;
                if (pending) await pending();
                return state.store.read(path);
            },
        };
        const panel = open_two_sheet_workbook(gated_store);
        const initial = await ready(panel);

        // Sheet 0 is sorted first so the resize below is quoted against a real
        // permutation, and its basis is what the resize will carry.
        const sorted = await sort_sheet_ascending(panel, initial, 0);
        const basis = sorted.view.basis;

        // The next durable read the handler performs installs a *second* sort on sheet 0,
        // moving that sheet's own mapping past the generation the pending resize quotes.
        intercept = async () => {
            await sort_sheet_ascending(
                panel,
                { ...initial, generation: basis.generation },
                0,
            );
        };
        await resize_sheet(panel, basis, 0, [{ start: 0, end: 1 }], 44);

        // A current request afterwards proves the abandoned one wrote nothing and was not
        // queued behind it — silence alone would also be consistent with "not finished".
        const current = messages_of(panel, 'transformInstalled').at(-1)!.view.basis;
        await resize_sheet(panel, current, 0, [{ start: 0, end: 0 }], 55);

        await vi.waitFor(() => expect(state.get_state(file_path).rowHeights?.[0])
            .toEqual({ 1: 55 }));
        expect(warnings()).toEqual([]);
    });
});
