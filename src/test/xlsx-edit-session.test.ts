import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, profile_for } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import CFB from 'cfb';
import type { PerFileState } from '../types';
import { parse_xlsx } from '../parse-xlsx';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

/**
 * The whole xlsx edit path, from the Edit button to the bytes on disk.
 *
 * The unit tests in xlsx-cell-write.test.ts already prove the splice preserves
 * untouched parts; what these ask is whether a save reaches it at all, with the
 * right worksheet and the right coordinates. That is where a worksheet-scoped
 * feature can go wrong silently: writing sheet 0's edits into sheet 1 produces a
 * perfectly valid file that is simply wrong.
 */

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): Uint8Array {
    return fs.readFileSync(path.join(FIXTURES, name));
}

function uri(file_path: string): vscode.Uri {
    return vscode_mock.Uri.file(file_path) as unknown as vscode.Uri;
}

function open_xlsx(
    file_path: string,
    state = versioned_state_store({}),
) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        uri(file_path),
        with_in_memory_authority_transactions(state.store),
        profile_for(file_path),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    // Stashed rather than returned: every caller wants the panel, and only the
    // disposed-cleanup test below needs to dispose and drain the controller itself.
    (panel as { __controller?: unknown }).__controller = controller;
    return panel;
}

function controller_of(panel: unknown) {
    return (panel as { __controller: {
        select_sheet(sheetName: string): Promise<boolean>;
        dispose(): void;
        drain(): Promise<void>;
    } }).__controller;
}

async function wait_for_observable(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((done) => { setImmediate(done); });
    }
    throw new Error('Observable result did not arrive.');
}

function has_snapshot(panel: { __messages: unknown[] }): boolean {
    return panel.__messages.some((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && (candidate as { type?: unknown }).type === 'workbookSnapshot'
    ));
}

function latest_snapshot(panel: { __messages: unknown[] }) {
    const message = [...panel.__messages].reverse().find((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && (candidate as { type?: unknown }).type === 'workbookSnapshot'
    )) as { snapshot: { identity: unknown } };
    return message.snapshot as unknown as {
        identity: unknown;
        capabilities: { csvEditSessionId?: string; csvEditSheetIndex?: number };
        state?: PerFileState;
    };
}

/** Open, and acknowledge the first snapshot: a save refuses until the webview
 *  has confirmed it is looking at the bytes the save will be validated against. */
async function open_ready_xlsx(
    file_path: string,
    state?: ReturnType<typeof versioned_state_store>,
) {
    const panel = open_xlsx(file_path, state);
    await panel.__receive({ type: 'ready' });
    // The source build is async, so the first snapshot arrives some turns after
    // `ready` resolves. Polled, never counted: a fixed number of turns that passes
    // here is a CI flake already written.
    await wait_for_observable(() => has_snapshot(panel));
    await panel.__receive({
        type: 'snapshotApplied',
        identity: latest_snapshot(panel).identity,
        disposition: 'applied',
    });
    return panel;
}

/** Worksheet names in the most recent delivered snapshot. */
function sheet_names(panel: { __messages: unknown[] }): string[] {
    const message = [...panel.__messages].reverse().find((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && (candidate as { type?: unknown }).type === 'workbookSnapshot'
    )) as { snapshot: { meta?: { sheets?: { name: string }[] } } } | undefined;
    return (message?.snapshot.meta?.sheets ?? []).map((sheet) => sheet.name);
}

function latest_edit_session(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is {
            type: string;
            granted: boolean;
            editSessionId?: string;
            sheetIndex?: number;
        } => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'editSessionResult'
        ),
    ).at(-1);
}

function save_results(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is { type: string; success: boolean } => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'saveResult'
        ),
    );
}

describe('xlsx edit sessions', () => {
    // Distinct per test: a controller registers against the file path, and a
    // panel from a previous test is still holding its own registration.
    let file_path: string;
    let case_index = 0;
    let bytes: Uint8Array;

    beforeEach(() => {
        vscode_mock.__reset();
        file_path = `/tmp/edit-me-${++case_index}.xlsx`;
        bytes = read_fixture('basic.xlsx');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength,
            mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
    });

    it('grants an edit session on .xlsx and refuses one on .xls', async () => {
        const xlsx = open_xlsx(file_path);
        await xlsx.__receive({ type: 'ready' });
        await xlsx.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        expect(latest_edit_session(xlsx)?.granted).toBe(true);

        // The writer is an OOXML package splice; .xls shares none of it, and the
        // profile must say so rather than failing inside a confirmed save.
        expect(profile_for('/tmp/legacy.xls').editing).toBe(false);
    });

    it('defers a requested worksheet until the save dialog is answered', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        let answer_dialog!: (choice: string | undefined) => void;
        const answer = new Promise<string | undefined>((resolve) => {
            answer_dialog = resolve;
        });
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage')
            .mockImplementation(() => answer);
        const dialog = panel.__receive({
            type: 'showSaveDialog',
            requestId: 'save-dialog',
            editSessionId: session,
        });
        await wait_for_observable(() => warning.mock.calls.length === 1);

        const selection = controller_of(panel).select_sheet('Inventory');
        expect(panel.__messages).not.toContainEqual({ type: 'selectSheet', sheetIndex: 1 });
        answer_dialog(undefined);
        await dialog;
        await expect(selection).resolves.toBe(true);

        expect(panel.__messages.flatMap((message) => {
            if (typeof message !== 'object' || message === null || !('type' in message)) return [];
            return message.type === 'saveDialogResult' || message.type === 'selectSheet'
                ? [message.type]
                : [];
        })).toEqual(['saveDialogResult', 'selectSheet']);
    });

    it('writes an edit into the worksheet the session named, leaving the other alone', async () => {
        const panel = await open_ready_xlsx(file_path);
        // Sheet 1 is "Inventory"; row 1 col 0 is "Widget" in the fixture.
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const before = await parse_xlsx(bytes);
        const people_before = before.data.sheets[0].rows[1][0]?.raw;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[1].rows[1][0]?.raw).toBe('Gadget');
        // The sibling worksheet is untouched, which is the whole point of the
        // worksheet being the edited object.
        expect(after.data.sheets[0].rows[1][0]?.raw).toBe(people_before);
    });

    it('refuses a session on a worksheet the workbook does not have', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 9 });
        expect(latest_edit_session(panel)?.granted).toBe(false);
    });

    it('refuses a save naming a worksheet the session does not hold', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const untouched = bytes;

        // A valid session id naming the other worksheet. The host must not take
        // the message's word for which sheet it is saving: the coordinates were
        // validated against sheet 1, and sheet 0's cells were never checked.
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 0,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(bytes).toBe(untouched);
    });

    it('fails the save, keeping the file, when a cell is in a formula group', async () => {
        // The writer refuses a shared or array formula rather than breaking the
        // group. That refusal happens at write time, after the user confirmed, so
        // what matters here is that it lands as a clean failed save with the file
        // untouched — not a half-written workbook.
        const raw = read_fixture('basic.xlsx');
        const file = CFB.read(raw, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet2.xml')!;
        const patched = Buffer.from(
            Buffer.from(sheet.content as Uint8Array).toString('utf8')
                .replace(
                    /<c r="A2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/,
                    '<c r="A2"><f t="shared" ref="A2:A3" si="0">B2*2</f><v>1</v></c>',
                ),
            'utf8',
        );
        sheet.content = patched;
        sheet.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);
        const untouched = bytes;

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const base = String(
            (await parse_xlsx(bytes)).data.sheets[1].rows[1][0]?.raw ?? '',
        );

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        // Not a base mismatch — the base was read from the patched file — so the
        // refusal is the writer's, which is what this test is about.
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(save_results(panel).at(-1)).not.toHaveProperty('rejection');
        expect(bytes).toBe(untouched);
    });

    it('refuses a save whose base no longer matches the cell', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const untouched = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Something else' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            rejection: { reason: 'baseMismatch' },
        });
        expect(bytes).toBe(untouched);
    });

    it('keeps another worksheet\u2019s unsaved draft through a save', async () => {
        // A draft on sheet 0 that outlived its session \u2014 the shape a closed panel
        // or a previous window leaves behind. Saving sheet 1 must not touch it: the
        // single-sheet code dropped the whole leaf, which is exactly this bug.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'People', cells: { '1:0': { value: 'Draft', base: 'Ada' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);

        // Opening the file rehydrates the draft's session on sheet 0, so sheet 1 is
        // refused until it is released \u2014 a session cannot move worksheets.
        await panel.__receive({ type: 'requestEditSession', requestId: 'a', sheetIndex: 1 });
        expect(latest_edit_session(panel)).toMatchObject({
            granted: false,
            sheetIndex: 0,
        });
        // The rehydrated session's id reaches the webview through the snapshot,
        // which is also how the real webview learns it holds one it never asked for.
        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId!,
        });
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSessionId === undefined,
        );

        await panel.__receive({ type: 'requestEditSession', requestId: 'b', sheetIndex: 1 });
        const session = latest_edit_session(panel)!;
        expect(session.granted).toBe(true);
        expect(session.sheetIndex).toBe(1);
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session.editSessionId!,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        // The saved sheet's durable slot is cleared after the write reports, so
        // that clear — not the save result — is the observable this waits on.
        await wait_for_observable(
            () => state.get_state(file_path).pendingEdits?.[1] === undefined,
        );

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(state.get_state(file_path).pendingEdits?.[0]?.cells)
            .toEqual({ '1:0': { value: 'Draft', base: 'Ada' } });
    });

    it('follows its worksheet when the workbook is reordered underneath it', async () => {
        // The session names a sheet by *position*, and an external reorder makes
        // that position somebody else's worksheet. Saving through the stale index
        // would splice this sheet's edits into the other one and produce a
        // perfectly valid, wrong workbook.
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSheetIndex === 0,
        );

        // "Inventory" is slot 0 now, and the session went with it: the save the
        // webview posts against the reloaded snapshot lands on Inventory's rows.
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 0,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        const inventory = after.data.sheets.find((sheet) => sheet.name === 'Inventory')!;
        const people = after.data.sheets.find((sheet) => sheet.name === 'People')!;
        expect(inventory.rows[1][0]?.raw).toBe('Gadget');
        expect(people.rows[1][0]?.raw).toBe('Alice');
    });

    it('refuses an edit request whose worksheet moves out from under it', async () => {
        // An established session *follows* its worksheet through a reorder (above),
        // because it knows which sheet is its own. A request in flight does not have
        // one yet: it validated an index before its state read, and a reorder landing
        // inside that read made the index somebody else's worksheet. Granting it
        // opened a session on `People` for a button pressed on `Inventory`, and every
        // keystroke after went into a sheet the user never chose.
        //
        // Refused, not retargeted: by now the grid the button was pressed on is being
        // replaced anyway, and pressing Edit again on the reordered grid works.
        const store = versioned_state_store({});
        let armed = false;
        let swapped = false;
        const read = store.store.read.bind(store.store);
        store.store.read = async (target: string) => {
            if (armed && !swapped) {
                swapped = true;
                bytes = swap_sheet_order(bytes);
                await vscode_mock.__getActiveWatchers()[0].__fireChange();
            }
            return read(target);
        };
        const panel = await open_ready_xlsx(file_path, store);
        expect(sheet_names(panel)).toEqual(['People', 'Inventory']);

        armed = true;
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        await wait_for_observable(() => latest_edit_session(panel) !== undefined);

        expect(latest_edit_session(panel)).toMatchObject({ granted: false, sheetIndex: 1 });
        // And the reorder is what caused it, so the workbook really did move.
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');
    });

    it('keeps a rehydrated session on its worksheet through a reorder', async () => {
        // A session nobody claimed interactively: the draft on disk rehydrates one
        // during adoption, and that claim happens *before* the new source is
        // installed, so it cannot name its own sheet from the workbook being
        // adopted. Unnamed, it would not follow the reorder below.
        const state = versioned_state_store({
            pendingEdits: [
                undefined,
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        const session = latest_snapshot(panel).capabilities.csvEditSessionId!;
        expect(latest_snapshot(panel).capabilities.csvEditSheetIndex).toBe(1);

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSheetIndex === 0,
        );

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 0,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        const inventory = after.data.sheets.find((sheet) => sheet.name === 'Inventory')!;
        const people = after.data.sheets.find((sheet) => sheet.name === 'People')!;
        expect(inventory.rows[1][0]?.raw).toBe('Gadget');
        expect(people.rows[1][0]?.raw).toBe('Alice');
    });

    it('rehydrates onto the worksheet a slot is tagged for, not the one it sits at', async () => {
        // Two slots tagged alike is what an external rename onto a name another slot
        // already recorded leaves behind, and reconciliation cannot place both: the
        // loser stays where it is, so an Inventory-tagged draft can sit at index 0
        // while sheet 0 is People. Adopting the first occupied slot by position
        // opened a People session holding Inventory's cells — and saving it wrote
        // them into People, the exact cross-worksheet corruption the tags prevent.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Mallory', base: 'Widget' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        expect(latest_snapshot(panel).capabilities.csvEditSheetIndex).toBe(1);

        const session = latest_snapshot(panel).capabilities.csvEditSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[1].rows[1][0]?.raw).toBe('Gadget');
        expect(after.data.sheets[0].rows[1][0]?.raw).toBe('Alice');
    });

    it('keeps a restored draft visible when the workbook is reordered', async () => {
        // Session and durable slots are *both* positional, and a reorder invalidates
        // each separately. Moving only the session leaves the projection reading the
        // wrong slot: it finds nothing and drops the leaf, so the draft disappears
        // from the grid while still sitting on disk — the user's unsaved work,
        // silently gone from view with no way to notice.
        const state = versioned_state_store({
            pendingEdits: [
                undefined,
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        expect(latest_snapshot(panel).capabilities.csvEditSheetIndex).toBe(1);

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSheetIndex === 0,
        );

        // Inventory is slot 0 now, and the draft moved with it.
        const projected = latest_snapshot(panel).state?.pendingEdits;
        expect(projected?.[0]?.cells).toEqual({ '1:0': { value: 'Draft', base: 'Widget' } });
    });

    it('gives up the session when its worksheet is gone from the workbook', async () => {
        // Not a relocation: there is no honest index to move the session to, so it
        // must not silently land on whatever sheet now holds that position.
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = drop_second_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSessionId === undefined,
        );

        // The old session id no longer buys a save on the surviving worksheet.
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 0,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Alice' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect((await parse_xlsx(bytes)).data.sheets[0].rows[1][0]?.raw).toBe('Alice');
    });

    it('clears a failed save\u2019s durable edits after its worksheet moves', async () => {
        // The save accepts its edits into Inventory's slot and then fails at the
        // write, leaving a tombstone whose cleanup runs when the session is
        // released. A reorder in between moves the slot: durable state is
        // reconciled by name on every write, so reading the captured *position*
        // found nothing, cleared the tombstone anyway, and the edits the failed
        // save made durable survived into the next session as a phantom draft.
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk is full');
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(state.get_state(file_path).pendingEdits?.[1]?.cells)
            .toEqual({ '1:0': { value: 'Gadget', base: 'Widget' } });

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSheetIndex === 0,
        );

        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId!,
        });
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSessionId === undefined,
        );
        // Asserted against the whole leaf, not a fixed slot: the durable array is
        // only reconciled when something writes it, so "gone" has to mean gone from
        // every slot rather than absent from the one Inventory now occupies.
        await wait_for_observable(() => !JSON.stringify(
            state.get_state(file_path).pendingEdits ?? null,
        ).includes('Gadget'));
    });

    it('fails a save whose worksheet is reordered away mid-flight', async () => {
        // The reorder lands after the operation is installed, so it stops being
        // current — but nothing else is holding the lifecycle. Returning quietly
        // left it `active` forever: no later save could start and no edit post
        // could be admitted, with no way for the user to get out of it.
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        // Reorder while the save is between its first await and the write.
        let reordered = false;
        vscode_mock.__setStatImplementation(async () => {
            if (!reordered) {
                reordered = true;
                bytes = swap_sheet_order(bytes);
                await vscode_mock.__getActiveWatchers()[0].__fireChange();
            }
            return { size: bytes.byteLength, mtime: 1 };
        });

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });

        // The lifecycle came back: a later save is admitted rather than blocked.
        const before = save_results(panel).length;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId ?? session,
                sheetIndex: 0,
                saveRequestId: 'save-2',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > before);
    });

    it('clears the discarded worksheet\u2019s slot after a reorder, not the neighbour\u2019s', async () => {
        // The discard's durable clear fails, leaving the cleanup `uncertain`; the
        // retry runs whenever editing is next requested, which may be long after an
        // external reorder. Durable slots are reconciled by name on the way into
        // that retry, so clearing by the captured *position* deleted People's
        // unsaved draft and left Inventory's behind — the exact inverse of what the
        // user asked for, and unrelated work lost silently.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'People', cells: { '1:0': { value: 'Draft', base: 'Alice' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Gadget', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        // The draft on sheet 0 rehydrates a session there; release it so the
        // discard below is about Inventory.
        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId!,
        });
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSessionId === undefined,
        );
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        // Fail the clear once, which is what strands the cleanup as `uncertain`.
        const inner = state.store.compare_and_set.bind(state.store);
        let failed_once = false;
        state.store.compare_and_set = async (...args) => {
            if (!failed_once && !JSON.stringify(args[2]).includes('Gadget')) {
                failed_once = true;
                throw new Error('state store is unavailable');
            }
            return inner(...args);
        };
        await panel.__receive({ type: 'discardEditSession', editSessionId: session });
        expect(failed_once).toBe(true);
        expect(JSON.stringify(state.get_state(file_path).pendingEdits)).toContain('Gadget');

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');

        // Requesting a session drives the recovery retry.
        await panel.__receive({ type: 'requestEditSession', requestId: 'y', sheetIndex: 0 });
        await wait_for_observable(() => !JSON.stringify(
            state.get_state(file_path).pendingEdits ?? null,
        ).includes('Gadget'));
        expect(JSON.stringify(state.get_state(file_path).pendingEdits)).toContain('Draft');
    });

    it('clears a disposed panel’s failed save by name, not by its old index', async () => {
        // Disposal drops `source` before the failed save's cleanup runs, so there is
        // no workbook left to resolve the operation's sheet name against — but
        // another window still attached can reorder the workbook and write
        // name-reconciled slots that this cleanup then reads. Falling back to the
        // captured position cleared whatever draft had inherited that index and left
        // the failed save's own entries behind, tombstone retired either way.
        const failed = { '1:0': { value: 'Gadget', base: 'Widget' } };
        const other = { '2:0': { value: 'Bob', base: 'Alice' } };
        const state = versioned_state_store({
            pendingEdits: [{ sheetName: 'People', cells: other }],
        });
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId!,
        });
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk is full');
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: failed,
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });

        // Stand in for the other window: commit the reordered, reconciled slots
        // under the cleanup's first write, so it retries against the new order.
        const inner = state.store.compare_and_set.bind(state.store);
        let reordered = false;
        state.store.compare_and_set = async (...args) => {
            if (!reordered) {
                reordered = true;
                const current = await state.store.read(args[0]);
                await inner(args[0], current.revision, {
                    ...(current.state as object),
                    pendingEdits: [
                        { sheetName: 'Inventory', cells: failed },
                        { sheetName: 'People', cells: other },
                    ],
                } as never);
            }
            return inner(...args);
        };

        controller_of(panel).dispose();
        await wait_for_observable(() => reordered);
        await controller_of(panel).drain();

        // Inventory's entries are the failed save's own and must go; People's draft
        // belongs to nobody in this flow and must stay.
        expect(state.get_state(file_path).pendingEdits).toEqual([
            undefined,
            { sheetName: 'People', cells: other },
        ]);
    });

    it('clears a disposed save’s own slot when two carry the same name', async () => {
        // Two slots tagged alike is what an external rename onto a name another
        // slot already recorded leaves behind. Taking the first match cleared a
        // draft this operation never owned and left its own failed-save entries
        // standing; the captured position still carries the name, so prefer it.
        const failed = { '1:0': { value: 'Gadget', base: 'Widget' } };
        const other = { '2:0': { value: 'Bob', base: 'Alice' } };
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk is full');
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: failed,
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        const inner = state.store.compare_and_set.bind(state.store);
        let injected = false;
        state.store.compare_and_set = async (...args) => {
            if (!injected) {
                injected = true;
                const current = await state.store.read(args[0]);
                await inner(args[0], current.revision, {
                    ...(current.state as object),
                    pendingEdits: [
                        { sheetName: 'Inventory', cells: other },
                        { sheetName: 'Inventory', cells: failed },
                    ],
                } as never);
            }
            return inner(...args);
        };

        controller_of(panel).dispose();
        await wait_for_observable(() => injected);
        await controller_of(panel).drain();

        // Trailing empty slots are trimmed, so the operation's own slot going is
        // the array getting shorter — the neighbour's draft is what must remain.
        expect(state.get_state(file_path).pendingEdits).toEqual([
            { sheetName: 'Inventory', cells: other },
        ]);
    });

    it('clears a disposed successful save by name, not by its old index', async () => {
        // The same hazard as the failed-save case, on the path that runs after every
        // ordinary save. Disposal drops `source` before the cleanup resolves its
        // sheet, and its fallback was the captured position — so a window still
        // attached that reordered the workbook meanwhile made the cleanup delete
        // whichever live draft had inherited that index, leaving the saved sheet's
        // own now-stale entries behind to reappear as phantom edits next session.
        const saved = { '1:0': { value: 'Gadget', base: 'Widget' } };
        const other = { '2:0': { value: 'Bob', base: 'Alice' } };
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        // Hold the write open so disposal lands before the cleanup resolves its
        // sheet — that is what leaves the cleanup with no source to ask.
        let release_write: (() => void) | undefined;
        let writing = false;
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            writing = true;
            await new Promise<void>((done) => { release_write = done; });
            bytes = new Uint8Array(content);
        });

        const save = panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: saved,
            },
        });
        await wait_for_observable(() => writing);

        // Stand in for the other window: commit the reordered, reconciled slots
        // under the cleanup's first write, so it retries against the new order.
        // Inventory — the saved sheet, captured at index 1 — is now at index 0.
        const inner = state.store.compare_and_set.bind(state.store);
        let reordered = false;
        state.store.compare_and_set = async (...args) => {
            if (!reordered) {
                reordered = true;
                const current = await state.store.read(args[0]);
                await inner(args[0], current.revision, {
                    ...(current.state as object),
                    pendingEdits: [
                        { sheetName: 'Inventory', cells: saved },
                        { sheetName: 'People', cells: other },
                    ],
                } as never);
            }
            return inner(...args);
        };

        controller_of(panel).dispose();
        release_write?.();
        await save;
        await wait_for_observable(() => reordered);
        await controller_of(panel).drain();

        // Inventory's entries are the save's own and must go; People's draft
        // belongs to nobody in this flow and must stay.
        expect(state.get_state(file_path).pendingEdits).toEqual([
            undefined,
            { sheetName: 'People', cells: other },
        ]);
    });

    it('follows its own entries when a duplicate tag inherited its captured index', async () => {
        // The captured position was preferred whenever the slot there carried the
        // right name — but with two slots tagged alike that slot can be an
        // unrelated draft that merely inherited the index, while the failed save's
        // own entries sit elsewhere. Cleanup then stripped nothing, retired the
        // tombstone anyway, and left its entries behind as a phantom draft that
        // reappeared next session. The operation's own entries say which slot is
        // really its own.
        const failed = { '1:0': { value: 'Gadget', base: 'Widget' } };
        const other = { '2:0': { value: 'Bob', base: 'Alice' } };
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk is full');
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: failed,
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        // The save's own entries are at 0; an unrelated same-named draft holds the
        // captured index 1.
        const inner = state.store.compare_and_set.bind(state.store);
        let injected = false;
        state.store.compare_and_set = async (...args) => {
            if (!injected) {
                injected = true;
                const current = await state.store.read(args[0]);
                await inner(args[0], current.revision, {
                    ...(current.state as object),
                    pendingEdits: [
                        { sheetName: 'Inventory', cells: failed },
                        { sheetName: 'Inventory', cells: other },
                    ],
                } as never);
            }
            return inner(...args);
        };

        controller_of(panel).dispose();
        await wait_for_observable(() => injected);
        await controller_of(panel).drain();

        expect(state.get_state(file_path).pendingEdits).toEqual([
            undefined,
            { sheetName: 'Inventory', cells: other },
        ]);
    });

    it('does not hand a displaced slot’s draft to the sheet sitting at its index', async () => {
        // Reconciliation cannot place two same-named slots at one index, so an
        // Inventory-tagged draft can sit at index 0 while sheet 0 is People. The
        // grant path read the slot purely by position, so asking to edit People
        // came back holding Inventory's cells — keyed to rows that mean something
        // else there, and one save away from writing them into the wrong sheet.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Mallory', base: 'Widget' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        // Rehydration adopts Inventory at its own index; release it so People can
        // be requested.
        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId!,
        });
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });

        const granted = latest_edit_session(panel)!;
        expect(granted.granted).toBe(true);
        expect(granted.sheetIndex).toBe(0);
        expect((granted as { pendingEdits?: unknown }).pendingEdits).toBeUndefined();
    });

    it('clears its entries from every same-named slot holding them', async () => {
        // Two slots tagged alike can both hold entries matching the operation's —
        // the user legitimately retyped the same value on the other worksheet's
        // draft — and nothing distinguishes them. Picking one deleted an unrelated
        // draft and left the failed save's own entries behind as a phantom. The
        // strip matches key *and* value, so removing them wherever they appear
        // under this name is exactly as targeted.
        const failed = {
            '1:0': { value: 'Gadget', base: 'Widget' },
            '2:0': { value: 'Shared', base: 'Gadget' },
        };
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk is full');
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget', '2:0': 'Shared' },
                dirtyEdits: failed,
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        // Slot 0 keeps the operation's partially-cleaned remainder; slot 1 holds an
        // unrelated draft that happens to share one exact entry.
        const inner = state.store.compare_and_set.bind(state.store);
        let injected = false;
        state.store.compare_and_set = async (...args) => {
            if (!injected) {
                injected = true;
                const current = await state.store.read(args[0]);
                await inner(args[0], current.revision, {
                    ...(current.state as object),
                    pendingEdits: [
                        {
                            sheetName: 'Inventory',
                            cells: { '1:0': { value: 'Gadget', base: 'Widget' } },
                        },
                        {
                            sheetName: 'Inventory',
                            cells: {
                                '2:0': { value: 'Shared', base: 'Gadget' },
                                '0:1': { value: 'Mine', base: 'Price' },
                            },
                        },
                    ],
                } as never);
            }
            return inner(...args);
        };

        controller_of(panel).dispose();
        await wait_for_observable(() => injected);
        await controller_of(panel).drain();

        // Both of the operation's entries are gone; the unrelated one survives.
        expect(state.get_state(file_path).pendingEdits).toEqual([
            undefined,
            { sheetName: 'Inventory', cells: { '0:1': { value: 'Mine', base: 'Price' } } },
        ]);
    });

    it('clears every same-named slot while the panel is still open', async () => {
        // Same ambiguity as above, reached by releasing the session rather than
        // disposing the panel. With the workbook still adopted, cleanup resolved
        // the worksheet's *position* and cleaned only the slot sitting there — but
        // reconciliation seats just one of two same-named slots at that index, so
        // the operation's entries survived in the other as a phantom draft, and
        // the tombstone was retired regardless.
        const failed = { '1:0': { value: 'Gadget', base: 'Widget' } };
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk is full');
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: failed,
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        // Both slots are tagged Inventory and both hold the failed entry; only one
        // can occupy Inventory's own index.
        const inner = state.store.compare_and_set.bind(state.store);
        let injected = false;
        state.store.compare_and_set = async (...args) => {
            if (!injected) {
                injected = true;
                const current = await state.store.read(args[0]);
                await inner(args[0], current.revision, {
                    ...(current.state as object),
                    pendingEdits: [
                        { sheetName: 'Inventory', cells: { ...failed } },
                        { sheetName: 'Inventory', cells: { ...failed } },
                    ],
                } as never);
            }
            return inner(...args);
        };

        await panel.__receive({ type: 'releaseEditSession', editSessionId: session });
        await wait_for_observable(() => injected);
        await controller_of(panel).drain();

        // The cleanup commit lands after the release settles, so poll for the
        // durable state rather than assuming a fixed number of turns.
        const remaining = () => (state.get_state(file_path).pendingEdits ?? [])
            .filter((slot: unknown) => slot !== undefined && slot !== null);
        await wait_for_observable(() => remaining().length === 0);
        expect(JSON.stringify(remaining())).toBe('[]');
    });


    it('keeps a displaced duplicate-tag draft when the sheet at its index is written', async () => {
        // Reconciliation seats only one of two same-named slots at their sheet's
        // own index; the other sits wherever a free position happens to be. That
        // position can be another worksheet's, and writing that worksheet's own
        // edits overwrote the displaced draft — unsaved work deleted with no
        // message asking to discard it, and recoverable work at that: the loser
        // moves back to its own index as soon as the winner clears.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Mallory', base: 'Widget' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        // Rehydration adopts Inventory at its own index; release it so People can
        // be requested.
        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId!,
        });
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            edits: { '0:0': { value: 'Bob', base: 'Alice' } },
        });
        await controller_of(panel).drain();
        const durable = () => JSON.stringify(state.get_state(file_path).pendingEdits ?? []);
        await wait_for_observable(() => durable().includes('Bob'));

        // People's own draft is stored, and neither Inventory draft was lost.
        expect(durable()).toContain('Mallory');
        expect(durable()).toContain('Draft');
    });

    it('keeps a displaced draft when a session with no durable map is discarded', async () => {
        // The discarded worksheet never published a durable map, so it has no slot
        // of its own and `slot_index_tagged` falls back to the captured index — which
        // a displaced same-named draft legitimately occupies, since reconciliation
        // seats only one of two same-named slots at their sheet's own index. The
        // clear emptied that position by number, deleting an unsaved draft that no
        // message asked to discard.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Mallory', base: 'Widget' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: latest_snapshot(panel).capabilities.csvEditSessionId!,
        });
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({ type: 'discardEditSession', editSessionId: session });
        await controller_of(panel).drain();

        const durable = JSON.stringify(state.get_state(file_path).pendingEdits ?? []);
        expect(durable, 'Mallory').toContain('Mallory');
        expect(durable, 'Draft').toContain('Draft');
    });

    it('keeps a durable draft when its worksheet is renamed externally', async () => {
        // Renaming a sheet in Excel with the file open made the draft's tag stop
        // resolving, and reconciliation dropped the slot — durably, so renaming it
        // back recovered nothing. A rename is not a deletion, and from the tag alone
        // the two are indistinguishable, so the draft has to survive.
        const state = versioned_state_store({
            pendingEdits: [
                undefined,
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        expect(sheet_names(panel)).toContain('Inventory');

        // Rename Inventory -> Stock in the workbook part, on disk, behind our back.
        const file = CFB.read(bytes, { type: 'buffer' });
        const wb = CFB.find(file, '/xl/workbook.xml')!;
        const text = Buffer.from(wb.content as Uint8Array).toString('utf8')
            .replace('name="Inventory"', 'name="Stock"');
        const patched = Buffer.from(text, 'utf8');
        wb.content = patched;
        wb.size = patched.length;
        const w = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = w instanceof Uint8Array ? w : new Uint8Array(w as ArrayBufferLike);

        await vscode_mock.__getWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel).includes('Stock'));
        await controller_of(panel).drain();

        const durable = JSON.stringify(state.get_state(file_path).pendingEdits ?? null);
        expect(durable, 'durable draft').toContain('Draft');
    });

    it('rehydrates a live draft sitting behind a parked one', async () => {
        // Declining the parked slot is right; stopping there was not. Only one
        // worksheet holds a session at a time, so this asks *which* — and a slot with
        // no worksheet is not an answer to that question, it is a slot to skip. The
        // first-occupied rule hid every later draft behind it, leaving a perfectly
        // live `Inventory` draft durable but invisible, recoverable only by renaming
        // a sheet the user may know nothing about.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'Ghost', cells: { '1:0': { value: 'Parked', base: 'Widget' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Real', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        const snapshot = latest_snapshot(panel);
        expect(snapshot.capabilities.csvEditSheetIndex).toBe(1);
        const projected = JSON.stringify(snapshot.state?.pendingEdits ?? null);
        expect(projected).toContain('Real');
        // And the parked draft is still not projected anywhere — it has no worksheet.
        expect(projected).not.toContain('Parked');
        expect(JSON.stringify(state.get_state(file_path).pendingEdits ?? null))
            .toContain('Parked');
    });

    it('does not project a parked foreign draft when the session moves onto its slot', async () => {
        // A parked slot has no worksheet, so it has no claim on an index either —
        // it is only sitting somewhere. Reconciliation placed it in the same pass as
        // slots whose names resolve, and array order decided: `Ghost` at 0 was
        // reached first, took index 0, and the `Inventory` slot that had a *right*
        // to that index found it occupied and fell aside. The session followed
        // `Inventory` to index 0 as it should and found `Ghost`'s cells there —
        // another worksheet's draft projected as the user's own, keyed to rows that
        // mean something else, with the real draft displaced and invisible.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'Ghost', cells: { '1:0': { value: 'Parked', base: 'Widget' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Real', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        expect(JSON.stringify(latest_snapshot(panel).state?.pendingEdits ?? null))
            .toContain('Real');

        // Externally reorder, so `Inventory` lands exactly where `Ghost` is parked.
        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => (
            sheet_names(panel)[0] === 'Inventory'
            && latest_snapshot(panel).capabilities.csvEditSheetIndex === 0
        ));

        const projected = JSON.stringify(latest_snapshot(panel).state?.pendingEdits ?? null);
        expect(projected).toContain('Real');
        expect(projected).not.toContain('Parked');
    });

    it('does not adopt a parked draft into the worksheet at its stale index', async () => {
        // A draft whose name the workbook no longer has is parked at its old index
        // rather than deleted, because a rename and a deletion look the same from
        // the tag alone. The index is therefore where the draft was *last* seen and
        // says nothing about what sits there now — but rehydration took it anyway,
        // opening a session on the unrelated worksheet at that position with the
        // parked cells projected into it. With matching bases the save then wrote
        // one worksheet's draft into another.
        const state = versioned_state_store({
            pendingEdits: [
                undefined,
                { sheetName: 'Ghost', cells: { '1:0': { value: 'Draft', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        // Sheet 1 is `Inventory`, and `Ghost` is nobody — so no session, and none
        // of `Ghost`'s cells reach `Inventory`.
        expect(sheet_names(panel)).toEqual(['People', 'Inventory']);
        const snapshot = latest_snapshot(panel);
        expect(snapshot.capabilities.csvEditSessionId).toBeUndefined();
        expect(JSON.stringify(snapshot.state?.pendingEdits ?? null)).not.toContain('Draft');
        // Declined, not discarded: the draft survives for the rename that brings
        // its worksheet back.
        expect(JSON.stringify(state.get_state(file_path).pendingEdits ?? null))
            .toContain('Draft');
    });

    it('preserves the styles part byte-for-byte across a save', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const styles_before = read_part(bytes, 'xl/styles.xml');

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                sheetIndex: 1,
                saveRequestId: 'save-1',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(read_part(bytes, 'xl/styles.xml')).toEqual(styles_before);
    });
});

/**
 * Swap the two `<sheet>` entries in the workbook part.
 *
 * The parts themselves are untouched, which is what an external reorder looks
 * like: the same worksheet XML, listed the other way round, so index 0 and index
 * 1 now name each other's sheet.
 */
function swap_sheet_order(zip: Uint8Array): Uint8Array {
    const file = CFB.read(zip, { type: 'buffer' });
    const entry = CFB.find(file, '/xl/workbook.xml')!;
    const xml = Buffer.from(entry.content as Uint8Array).toString('utf8');
    const sheets = [...xml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
    expect(sheets).toHaveLength(2);
    const swapped = Buffer.from(
        xml.replace(sheets[0] + sheets[1], sheets[1] + sheets[0]),
        'utf8',
    );
    entry.content = swapped;
    entry.size = swapped.length;
    const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
    return written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike);
}

/** Drop the second `<sheet>` entry, as deleting that worksheet elsewhere would. */
function drop_second_sheet(zip: Uint8Array): Uint8Array {
    const file = CFB.read(zip, { type: 'buffer' });
    const entry = CFB.find(file, '/xl/workbook.xml')!;
    const xml = Buffer.from(entry.content as Uint8Array).toString('utf8');
    const sheets = [...xml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
    expect(sheets).toHaveLength(2);
    const trimmed = Buffer.from(xml.replace(sheets[1], ''), 'utf8');
    entry.content = trimmed;
    entry.size = trimmed.length;
    const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
    return written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike);
}

function read_part(zip: Uint8Array, part: string): Buffer | null {
    const entry = CFB.find(CFB.read(zip, { type: 'buffer' }), `/${part}`);
    return entry?.content ? Buffer.from(entry.content as Uint8Array) : null;
}
