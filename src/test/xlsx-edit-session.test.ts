import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, profile_for } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import CFB from 'cfb';
import {
    decode_stored_per_file_state,
    type PerFileState,
    type SheetPendingEditCells,
} from '../types';
import { parse_xlsx } from '../parse-xlsx';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';
import { sheet_cells } from './pending-edits-helper';

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
    profile: ReturnType<typeof profile_for> = profile_for(file_path),
) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        uri(file_path),
        with_in_memory_authority_transactions(state.store),
        profile,
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
        generation: number;
        sourceGeneration: number;
        capabilities: { csvEditSessionId?: string };
        meta: { sheets: { name: string; worksheetId?: string }[] };
        state?: PerFileState;
    };
}

/** Open, and acknowledge the first snapshot: a save refuses until the webview
 *  has confirmed it is looking at the bytes the save will be validated against. */
async function open_ready_xlsx(
    file_path: string,
    state?: ReturnType<typeof versioned_state_store>,
    profile?: ReturnType<typeof profile_for>,
) {
    const panel = open_xlsx(file_path, state, profile);
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
    return latest_snapshot(panel).meta.sheets.map((sheet) => sheet.name);
}

function latest_edit_session(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is {
            type: string;
            granted: boolean;
            editSessionId?: string;
            sheetIndex?: number;
            pendingEdits?: SheetPendingEditCells;
        } => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'editSessionResult'
        ),
    ).at(-1);
}

function save_results(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is {
            type: string;
            success: boolean;
            lifecycle: { operation: import('../types').CsvSaveOperation };
        } => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'saveResult'
        ),
    );
}

async function worksheet_loss_flush_request(
    panel: { __messages: unknown[] },
): Promise<{ requestId: string }> {
    let request: { requestId: string } | undefined;
    await wait_for_observable(() => {
        request = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'requestPendingEditsFlush'
            && String((message as { requestId?: unknown }).requestId)
                .startsWith('worksheet-loss:')
        )) as { requestId: string } | undefined;
        return request !== undefined;
    });
    return request!;
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

    async function open_with_plan_spy() {
        const base_profile = profile_for(file_path);
        if (!base_profile.editing) throw new Error('XLSX profile must be editable.');
        const plan_save = vi.fn(base_profile.plan_save);
        const panel = await open_ready_xlsx(file_path, undefined, {
            ...base_profile,
            plan_save,
        });
        return { panel, plan_save };
    }

    function save_worksheet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            edits: { '1:0': 'Alicia' },
            dirtyEdits: { '1:0': { value: 'Alicia', base: 'Alice' } },
            ...overrides,
        };
    }

    function with_shared_formula_follower(raw: Uint8Array): Uint8Array {
        const file = CFB.read(raw, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet2.xml')!;
        const before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const patched_text = before
            .replace(
                /<c r="A2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/,
                '<c r="A2"><f t="shared" ref="A2:A3" si="0">B2*2</f><v>1</v></c>',
            )
            .replace(
                /<c r="A3"[^>]*(?:\/>|>[\s\S]*?<\/c>)/,
                '<c r="A3"><f t="shared" si="0"/><v>2</v></c>',
            );
        expect(patched_text).toContain(
            '<f t="shared" ref="A2:A3" si="0">B2*2</f>',
        );
        expect(patched_text).toContain('<c r="A3"><f t="shared" si="0"/><v>2</v></c>');
        const patched = Buffer.from(patched_text, 'utf8');
        sheet.content = patched;
        sheet.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        return written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);
    }

    function workbook_request(
        session: string,
        request_id: string,
        worksheet: unknown,
    ): Record<string, unknown> {
        return {
            editSessionId: session,
            saveRequestId: request_id,
            worksheets: [worksheet],
        };
    }

    it('grants an edit session on .xlsx and refuses one on .xls', async () => {
        const xlsx = open_xlsx(file_path);
        await xlsx.__receive({ type: 'ready' });
        await xlsx.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        expect(latest_edit_session(xlsx)?.granted).toBe(true);

        // The writer is an OOXML package splice; .xls shares none of it, and the
        // profile must say so rather than failing inside a confirmed save.
        expect(profile_for('/tmp/legacy.xls').editing).toBe(false);
        expect(profile_for('/tmp/read-only.dta').editing).toBe(false);
    });

    it.each([
        ['a missing index', undefined],
        ['a null index', null],
        ['NaN', Number.NaN],
        ['infinity', Number.POSITIVE_INFINITY],
        ['a fractional index', 0.5],
        ['a negative index', -1],
        ['an unsafe index', Number.MAX_SAFE_INTEGER + 1],
    ])('refuses %s before planning', async (_label, sheet_index) => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const before = bytes;
        const requested = save_worksheet({ sheetIndex: sheet_index });
        if (sheet_index === undefined) delete requested.sheetIndex;

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, `invalid-sheet:${_label}`, requested),
        } as never);
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            lifecycle: { state: 'failed', failure: 'malformedRequest' },
        });
        expect(plan_save).not.toHaveBeenCalled();
        expect(bytes).toEqual(before);
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
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

    it('saves and exits the first of two editing files after an auto-grown row height', async () => {
        // A sparse per-sheet array is persisted with JSON nulls. Editing a long
        // value can auto-grow a row before the save-on-exit request arrives, so
        // this is the user-visible sequence that used to leave the durable height
        // written but make the following save fail with Object.keys(null).
        const second_path = `/tmp/edit-peer-${case_index}.xlsx`;
        const initial_a = read_fixture('basic.xlsx');
        const initial_b = read_fixture('basic.xlsx');
        const disks = new Map<string, Uint8Array>([
            [file_path, initial_a],
            [second_path, initial_b],
        ]);
        vscode_mock.__setStatImplementation(async (resource) => {
            const content = disks.get(resource.fsPath);
            if (!content) throw new Error('missing test file');
            return { size: content.byteLength, mtime: 1 };
        });
        vscode_mock.__setReadFileImplementation(async (resource) => {
            const content = disks.get(resource.fsPath);
            if (!content) throw new Error('missing test file');
            return content;
        });
        vscode_mock.__setWriteFileImplementation(async (resource, content) => {
            disks.set(resource.fsPath, new Uint8Array(content));
        });
        const state = versioned_state_store(decode_stored_per_file_state({
            rowHeights: [null, null],
        }));
        const first = await open_ready_xlsx(file_path, state);
        const second = await open_ready_xlsx(second_path, state);
        await first.__receive({ type: 'requestEditSession', requestId: 'edit-a', sheetIndex: 0 });
        await second.__receive({ type: 'requestEditSession', requestId: 'edit-b', sheetIndex: 0 });
        const first_result = latest_edit_session(first);
        const second_result = latest_edit_session(second);
        expect(first_result).toMatchObject({ granted: true, editSessionId: expect.any(String) });
        expect(second_result).toMatchObject({ granted: true, editSessionId: expect.any(String) });
        const first_session = first_result!.editSessionId!;
        const second_session = second_result!.editSessionId!;
        expect(first_session).not.toBe('');
        expect(second_session).not.toBe('');
        expect(latest_snapshot(first).capabilities.csvEditSessionId).toBe(first_session);
        expect(latest_snapshot(second).capabilities.csvEditSessionId).toBe(second_session);
        const basis = latest_snapshot(first);

        await first.__receive({
            type: 'setRowHeights',
            sheetIndex: 0,
            rows: [{ start: 1, end: 1 }],
            height: 44,
            generation: basis.generation,
            sourceGeneration: basis.sourceGeneration,
        });
        await wait_for_observable(() => (
            // People promotes its first source row to headers, so display row 1
            // maps back to canonical source row 2.
            state.get_state(file_path).rowHeights?.[0]?.[2] === 44
        ));

        await first.__receive({
            type: 'saveCsv',
            operation: workbook_request(first_session, 'save-a', save_worksheet()),
        });
        await wait_for_observable(() => save_results(first).length > 0);
        await wait_for_observable(
            () => latest_snapshot(first).capabilities.csvEditSessionId === undefined,
        );

        expect(save_results(first).at(-1)).toMatchObject({ success: true });
        expect(latest_snapshot(second).capabilities.csvEditSessionId).toBe(second_session);
        const saved_a = await parse_xlsx(disks.get(file_path)!);
        expect(saved_a.data.sheets[0].rows[1][0]?.raw).toBe('Alicia');
        expect(disks.get(second_path)).toEqual(initial_b);
    });

    it('writes a styled edit as a rich inline string the reader resolves back', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-rich',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: { '1:0': 'plain bold' },
                    dirtyEdits: {
                        '1:0': {
                            value: 'plain bold',
                            base: 'Alice',
                            valueRuns: {
                                runs: [
                                    { text: 'plain ' },
                                    { text: 'bold', style: { bold: true } },
                                ],
                            },
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        const cell = after.data.sheets[0].rows[1][0];
        expect(cell?.raw).toBe('plain bold');
        expect(cell?.richText).toEqual({
            runs: [
                { text: 'plain ' },
                { text: 'bold', style: { bold: true } },
            ],
        });
    });

    it('writes a hyperlink-only edit without rewriting the cell', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const before = await parse_xlsx(bytes);
        const base_text = String(before.data.sheets[0].rows[1][0]?.raw ?? '');

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-link',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    // A link-only edit contributes no text edit at all: the
                    // cell's own `<c>` element must survive untouched.
                    edits: {},
                    dirtyEdits: {
                        '1:0': {
                            value: base_text,
                            base: base_text,
                            link: { kind: 'external', target: 'https://example.com/a' },
                            baseLink: null,
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        const cell = after.data.sheets[0].rows[1][0];
        expect(cell?.raw).toBe(base_text);
        expect(cell?.hyperlink).toEqual({
            kind: 'external',
            target: 'https://example.com/a',
        });
    });

    it('clears a hyperlink the workbook already carried', async () => {
        // Seed the fixture with an internal link (no relationship part needed),
        // so this exercises the clear against a link the *file* owns rather than
        // one this same session just wrote.
        const raw = read_fixture('basic.xlsx');
        const file = CFB.read(raw, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const patched = Buffer.from(
            Buffer.from(sheet.content as Uint8Array).toString('utf8').replace(
                '</sheetData>',
                '</sheetData><hyperlinks><hyperlink ref="A2" location="Inventory!A1"/></hyperlinks>',
            ),
            'utf8',
        );
        sheet.content = patched;
        sheet.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const seeded = await parse_xlsx(bytes);
        const base_link = seeded.data.sheets[0].rows[1][0]?.hyperlink;
        expect(base_link).toEqual({ kind: 'internal', location: 'Inventory!A1' });
        const base_text = String(seeded.data.sheets[0].rows[1][0]?.raw ?? '');

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-clear',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: {},
                    dirtyEdits: {
                        '1:0': {
                            value: base_text,
                            base: base_text,
                            link: null,
                            baseLink: base_link,
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[1][0]?.hyperlink).toBeUndefined();
        expect(after.data.sheets[0].rows[1][0]?.raw).toBe(base_text);
    });

    it('refuses a hyperlink whose base no longer matches the cell', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const base_text = String(
            (await parse_xlsx(bytes)).data.sheets[0].rows[1][0]?.raw ?? '',
        );
        const untouched = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-stale',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: {},
                    dirtyEdits: {
                        '1:0': {
                            value: base_text,
                            base: base_text,
                            link: { kind: 'external', target: 'https://example.com/a' },
                            // The cell has no link, so this base is stale.
                            baseLink: { kind: 'external', target: 'https://was-here.test/' },
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0 },
        });
        expect(bytes).toBe(untouched);
    });

    it('fails the save rather than writing a non-http hyperlink target', async () => {
        // The webview validates before offering Save, so a target like this can
        // only arrive from a stale or tampered renderer. The host re-validates
        // and refuses: nothing unvalidated reaches the file, or later the OS
        // opener that reads it back.
        const show_error = vi.spyOn(vscode_mock.window, 'showErrorMessage');
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const base_text = String(
            (await parse_xlsx(bytes)).data.sheets[0].rows[1][0]?.raw ?? '',
        );
        const untouched = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-bad-url',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: {},
                    dirtyEdits: {
                        '1:0': {
                            value: base_text,
                            base: base_text,
                            link: { kind: 'external', target: 'javascript:alert(1)' },
                            baseLink: null,
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        // Pin the cause: this guards a security control, so a save that failed
        // for some unrelated plumbing regression must not pass as a refusal.
        // The rejection reason is not on the wire message (the planner throws),
        // so the user-facing error is where it surfaces.
        expect(show_error.mock.calls.some(([message]) => /hyperlink/i.test(String(message))))
            .toBe(true);
        expect(bytes).toBe(untouched);
        show_error.mockRestore();
    });

    it('drops wire runs whose text disagrees with the edit and writes the plain value', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-smuggled',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: { '1:0': 'Alicia' },
                    dirtyEdits: {
                        '1:0': {
                            value: 'Alicia',
                            base: 'Alice',
                            // Malicious/buggy renderer: runs spelling a different
                            // value than the one base validation checked. The
                            // sanitizer drops the runs; the validated text wins.
                            valueRuns: {
                                runs: [{ text: 'SMUGGLED', style: { bold: true } }],
                            },
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        const cell = after.data.sheets[0].rows[1][0];
        expect(cell?.raw).toBe('Alicia');
        expect(cell?.richText).toBeUndefined();
    });

    it('writes and clears several worksheets as one atomic workbook save', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-workbook',
                worksheets: [
                    {
                        sheetIndex: 0,
                        sheetName: 'People',
                        worksheetId: '1',
                        edits: { '1:0': 'Alicia' },
                        dirtyEdits: { '1:0': { value: 'Alicia', base: 'Alice' } },
                    },
                    {
                        sheetIndex: 1,
                        sheetName: 'Inventory',
                        worksheetId: '2',
                        edits: { '1:0': 'Gadget' },
                        dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                    },
                ],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: true });

        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[1][0]?.raw).toBe('Alicia');
        expect(after.data.sheets[1].rows[1][0]?.raw).toBe('Gadget');
        await controller_of(panel).drain();
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('validates every worksheet before writing any workbook bytes', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const untouched = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'conflicted-workbook',
                worksheets: [
                    {
                        sheetIndex: 0,
                        sheetName: 'People',
                        worksheetId: '1',
                        edits: { '1:0': 'Alicia' },
                        dirtyEdits: { '1:0': { value: 'Alicia', base: 'Alice' } },
                    },
                    {
                        sheetIndex: 1,
                        sheetName: 'Inventory',
                        worksheetId: '2',
                        edits: { '1:0': 'Gadget' },
                        dirtyEdits: { '1:0': { value: 'Gadget', base: 'wrong' } },
                    },
                ],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 1 },
        });
        expect(bytes).toBe(untouched);
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[1][0]?.raw).toBe('Alice');
        expect(after.data.sheets[1].rows[1][0]?.raw).toBe('Widget');
    });

    it.each([
        ['a present non-array worksheets field', null],
        ['an empty workbook operation', []],
    ])('rejects %s before planning', async (_label, worksheets) => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const untouched = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'legacy-with-malformed-worksheets',
                sheetIndex: 1,
                sheetName: 'Inventory',
                worksheetId: '2',
                edits: { '1:0': 'Gadget' },
                dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                worksheets,
            },
        } as never);
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            lifecycle: { state: 'failed', failure: 'malformedRequest' },
        });
        expect(plan_save).not.toHaveBeenCalled();
        expect(bytes).toBe(untouched);
    });

    it.each([
        ['a null worksheet element', () => null],
        ['a primitive worksheet element', () => 'worksheet'],
        ['a null edits container', () => save_worksheet({ edits: null })],
        ['an array edits container', () => save_worksheet({ edits: [] })],
        ['a null dirtyEdits container', () => save_worksheet({ dirtyEdits: null })],
        ['an array dirtyEdits container', () => save_worksheet({ dirtyEdits: [] })],
        ['a malformed dirty entry', () => save_worksheet({
            dirtyEdits: { '1:0': null },
        })],
        ['a non-string edit value', () => save_worksheet({
            edits: { '1:0': 7 },
        })],
        ['an extra edit entry', () => save_worksheet({
            edits: { '1:0': 'Alicia', '1:1': 'unvalidated' },
        })],
        ['a missing edit entry', () => save_worksheet({ edits: {} })],
        ['an edit value that disagrees with dirtyEdits', () => save_worksheet({
            edits: { '1:0': 'Mallory' },
        })],
    ])('rejects %s atomically before planning', async (_label, make_worksheet) => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const untouched = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                session,
                `malformed:${_label}`,
                make_worksheet(),
            ),
        } as never);
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            lifecycle: { state: 'failed', failure: 'malformedRequest' },
        });
        expect(plan_save).not.toHaveBeenCalled();
        expect(bytes).toBe(untouched);
    });

    it('accepts a valid save after a correlated malformed request', async () => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                session,
                'malformed-before-valid',
                save_worksheet({ edits: { '1:0': 'Alicia', '1:1': 'extra' } }),
            ),
        } as never);
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            lifecycle: { state: 'failed', failure: 'malformedRequest' },
        });
        expect(plan_save).not.toHaveBeenCalled();

        const result_count = save_results(panel).length;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'valid-after-malformed', save_worksheet()),
        });
        await wait_for_observable(() => save_results(panel).length > result_count);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(plan_save).toHaveBeenCalledTimes(1);
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[1][0]?.raw).toBe('Alicia');
    });

    it('fails closed on uncorrelatable operation envelopes and accepts a later save', async () => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const untouched = bytes;

        for (const operation of [null, 17, []]) {
            await panel.__receive({ type: 'saveCsv', operation } as never);
        }

        expect(save_results(panel)).toHaveLength(0);
        expect(plan_save).not.toHaveBeenCalled();
        expect(bytes).toBe(untouched);

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'valid-after-bad-envelope', save_worksheet()),
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(plan_save).toHaveBeenCalledTimes(1);
    });

    it('rejects duplicate physical worksheets before planning', async () => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'duplicate-physical-sheet',
                worksheets: [
                    {
                        sheetIndex: 1,
                        worksheetId: '2',
                        edits: { '1:0': 'Gadget' },
                        dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                    },
                    {
                        sheetIndex: 1,
                        sheetName: 'Inventory',
                        edits: { '1:1': '25' },
                        dirtyEdits: { '1:1': { value: '25', base: '10' } },
                    },
                ],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            lifecycle: { state: 'failed', failure: 'malformedRequest' },
        });
        expect(plan_save).not.toHaveBeenCalled();
        expect(panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'saveOperationStarted'
        ))).toBe(false);
    });

    it('rejects duplicate strongest worksheet identities before planning', async () => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'duplicate-worksheet-id',
                worksheets: [
                    {
                        sheetIndex: 0,
                        worksheetId: '2',
                        edits: { '1:0': 'Gadget' },
                        dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                    },
                    {
                        sheetIndex: 1,
                        worksheetId: '2',
                        edits: { '1:1': '25' },
                        dirtyEdits: { '1:1': { value: '25', base: '10' } },
                    },
                ],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            lifecycle: { state: 'failed', failure: 'malformedRequest' },
        });
        expect(plan_save).not.toHaveBeenCalled();
    });

    it('rejects an identity-less save for a multi-sheet workbook', async () => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'identity-less',
                worksheets: [{
                    sheetIndex: 1,
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(plan_save).not.toHaveBeenCalled();
    });

    it('refuses a session on a worksheet the workbook does not have', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 9 });
        expect(latest_edit_session(panel)?.granted).toBe(false);
    });

    it('refuses a queued edit request whose stamped worksheet left its index', async () => {
        const panel = await open_ready_xlsx(file_path);
        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');

        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'stale-index',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
        });

        expect(latest_edit_session(panel)).toMatchObject({
            requestId: 'stale-index',
            granted: false,
            sheetIndex: 1,
        });
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
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
            (await parse_xlsx(bytes)).data.sheets[1].rows[1][0]?.formula ?? '',
        );

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        // Not a base mismatch — the base was read from the patched file — so the
        // refusal is the writer's, which is what this test is about.
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(save_results(panel).at(-1)).not.toHaveProperty('rejection');
        expect(bytes).toBe(untouched);
    });

    it('refuses a literal over a shared-formula follower without modifying the file', async () => {
        bytes = with_shared_formula_follower(read_fixture('basic.xlsx'));
        const untouched = bytes;

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const base = String(
            (await parse_xlsx(bytes)).data.sheets[1].rows[2][0]?.formula ?? '',
        );

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-shared-follower',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '2:0': 'Gadget' },
                    dirtyEdits: { '2:0': { value: 'Gadget', base } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(bytes).toBe(untouched);
    });

    it('saves a formula edit over a shared-formula follower', async () => {
        bytes = with_shared_formula_follower(read_fixture('basic.xlsx'));
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const base = String(
            (await parse_xlsx(bytes)).data.sheets[1].rows[2][0]?.formula ?? '',
        );
        expect(base).toBe('=B3*2');

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-shared-formula-edit',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '2:0': '=B3*3' },
                    dirtyEdits: { '2:0': { value: '=B3*3', base } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const saved = CFB.read(bytes, { type: 'buffer' });
        const saved_sheet = Buffer.from(
            CFB.find(saved, '/xl/worksheets/sheet2.xml')!.content as Uint8Array,
        ).toString('utf8');
        expect(saved_sheet).toContain('<c r="A3"><f>B3*3</f><v>73.5</v></c>');
        expect(saved_sheet).toContain(
            '<f t="shared" ref="A2:A3" si="0">B2*2</f>',
        );
        expect((await parse_xlsx(bytes)).data.sheets[1].rows[2][0])
            .toMatchObject({
                formula: '=B3*3',
                raw: 73.5,
                formatted: '73.5',
            });
    });

    it('recalculates and reopens the garden-cafe shelf value after a price edit', async () => {
        bytes = fs.readFileSync('docs/examples/garden-cafe-sample.xlsx');
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 4 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'garden-cafe-price-edit',
                worksheets: [{
                    sheetIndex: 4,
                    sheetName: 'Berry Corner',
                    worksheetId: '5',
                    edits: { '2:5': '5.24' },
                    dirtyEdits: { '2:5': { value: '5.24', base: '5.25' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const reopened = (await parse_xlsx(bytes)).data.sheets[4];
        expect(reopened.rows[2][4]?.raw).toBe(9);
        expect(reopened.rows[2][5]?.raw).toBe(5.24);
        expect(reopened.rows[2][8]).toMatchObject({
            formula: '=E3*F3',
            raw: 47.16,
            formatted: '$47.16',
        });
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Something else' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0 },
        });
        expect(bytes).toBe(untouched);
    });

    it('keeps another worksheet\u2019s unsaved draft through a save', async () => {
        // A draft on sheet 0 that outlived its session \u2014 the shape a closed panel
        // or a previous window leaves behind. Saving sheet 1 must not touch it: the
        // single-sheet code dropped the whole leaf, which is exactly this bug.
        // The base matches the fixture ('Alice'), so the rehydrated draft
        // validates cleanly \u2014 both at open and when the surviving slot
        // re-projects after the sibling sheet's save.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'People', cells: { '1:0': { value: 'Draft', base: 'Alice' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);

        // Opening the file rehydrates the draft's workbook-scoped session, and a
        // request for sheet 1 is that same session \u2014 granted, on the sheet asked.
        await panel.__receive({ type: 'requestEditSession', requestId: 'b', sheetIndex: 1 });
        const session = latest_edit_session(panel)!;
        expect(session.granted).toBe(true);
        expect(session.sheetIndex).toBe(1);
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session.editSessionId!,
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        await controller_of(panel).drain();
        expect(state.get_state(file_path).pendingEdits?.[1]).toBeUndefined();
        expect(sheet_cells(state.get_state(file_path).pendingEdits, 0))
            .toEqual({ '1:0': { value: 'Draft', base: 'Alice' } });
        // And the draft still reaches the panel. The clear's snapshot carries the
        // surviving slot at the very revision the clear completed, so recording
        // that revision as \u201ceverything at or below is cleared\u201d would
        // strip the sibling draft from every projection from here on \u2014
        // durable on disk, invisible in the grid.
        await wait_for_observable(() => JSON.stringify(
            sheet_cells(latest_snapshot(panel).state?.pendingEdits, 0) ?? null,
        ).includes('Draft'));
    });

    it('settles an admitted sibling clear before successful save cleanup', async () => {
        const state = versioned_state_store({
            pendingEdits: [{
                sheetName: 'People',
                worksheetId: '1',
                cells: { '1:0': { value: 'Draft', base: 'Alice' } },
            }],
        });
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'edit-inventory',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
        });
        const session = latest_edit_session(panel)!.editSessionId!;

        let release_write: (() => void) | undefined;
        let writing = false;
        let write_completed = false;
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            writing = true;
            await new Promise<void>((done) => { release_write = done; });
            bytes = new Uint8Array(content);
            write_completed = true;
        });

        const compare = state.store.compare_and_set.bind(state.store);
        let release_publication_write: (() => void) | undefined;
        let publication_write_pending = false;
        state.store.compare_and_set = async (...args) => {
            if (
                writing
                && !publication_write_pending
                && !JSON.stringify(args[2]).includes('Draft')
            ) {
                publication_write_pending = true;
                await new Promise<void>((done) => {
                    release_publication_write = done;
                });
            }
            return compare(...args);
        };
        const save = panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-inventory',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => writing);

        const publication = panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            edits: null,
        });
        await wait_for_observable(() => publication_write_pending);
        release_write!();
        await wait_for_observable(() => write_completed);

        // Physical save has completed, but successful cleanup cannot revoke the
        // session authority under the sibling publication already inside its CAS.
        expect(save_results(panel)).toHaveLength(0);
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingEditsAcknowledged',
            editSessionId: session,
            sequence: 1,
        });

        release_publication_write!();
        await Promise.all([save, publication]);
        await controller_of(panel).drain();

        expect(panel.__messages).toContainEqual({
            type: 'pendingEditsAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(JSON.stringify(state.get_state(file_path).pendingEdits ?? null))
            .not.toContain('Draft');
        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
    });

    it('follows its worksheet when the workbook is reordered underneath it', async () => {
        // A save names a sheet by *position*, and an external reorder makes
        // that position somebody else's worksheet. Saving through the stale index
        // would splice this sheet's edits into the other one and produce a
        // perfectly valid, wrong workbook. The workbook-scoped session survives
        // the reorder; the save posted against the reloaded snapshot names the
        // sheet's new index and lands on the right rows.
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');

        // "Inventory" is slot 0 now, and the session went with it: the save the
        // webview posts against the reloaded snapshot lands on Inventory's rows.
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
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

    it('rejects a save whose posted worksheet name moved away from its index', async () => {
        const { panel, plan_save } = await open_with_plan_spy();
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');
        const before = bytes;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'stale-sheet-index',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(plan_save).not.toHaveBeenCalled();
        expect(bytes).toEqual(before);
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
        expect(sheet_cells(latest_snapshot(panel).state?.pendingEdits, 1))
            .toEqual({ '1:0': { value: 'Draft', base: 'Widget' } });

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
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
        // The projection shows the winning slot at Inventory's own index and
        // withholds the displaced duplicate.
        expect(sheet_cells(latest_snapshot(panel).state?.pendingEdits, 1))
            .toEqual({ '1:0': { value: 'Draft', base: 'Widget' } });
        expect(latest_snapshot(panel).state?.pendingEdits?.[0]).toBeUndefined();

        const session = latest_snapshot(panel).capabilities.csvEditSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
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
        expect(sheet_cells(latest_snapshot(panel).state?.pendingEdits, 1))
            .toEqual({ '1:0': { value: 'Draft', base: 'Widget' } });

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        // Inventory is slot 0 now, and the draft moved with it.
        await wait_for_observable(() => {
            const entry = sheet_cells(
                latest_snapshot(panel).state?.pendingEdits,
                0,
            )?.['1:0'];
            return sheet_names(panel)[0] === 'Inventory'
                && (typeof entry === 'string' ? entry : entry?.value) === 'Draft';
        });
    });

    it('grants the requested sheet its relocated draft after a reorder', async () => {
        // The installed source already has the new workbook order, while the
        // durable read made by the request still carries slots written in the old
        // order. This is the real authority boundary: state is positional on disk
        // and can lag workbook bytes until a write reconciles it. Taking index 0
        // directly would therefore return no draft for Inventory.
        const state = versioned_state_store({});
        let expose_old_order_slots = false;
        const read = state.store.read.bind(state.store);
        state.store.read = async (target: string) => {
            const snapshot = await read(target);
            return expose_old_order_slots
                ? {
                    ...snapshot,
                    state: {
                        pendingEdits: [
                            undefined,
                            {
                                sheetName: 'Inventory',
                                cells: { '1:0': { value: 'Draft', base: 'Widget' } },
                            },
                        ],
                    },
                }
                : snapshot;
        };
        bytes = swap_sheet_order(bytes);
        const panel = await open_ready_xlsx(file_path, state);
        expect(sheet_names(panel)).toEqual(['Inventory', 'People']);

        expose_old_order_slots = true;
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'reordered-inventory',
            sheetIndex: 0,
        });

        expect(latest_edit_session(panel)).toMatchObject({
            granted: true,
            sheetIndex: 0,
            pendingEdits: {
                '1:0': { value: 'Draft', base: 'Widget' },
            },
        });
    });

    it('admits a pending-edit post by sheet name after a reorder', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'inventory',
            sheetIndex: 1,
        });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            // Inventory moved to index 0 while this full-map post was queued.
            sheetIndex: 1,
            sheetName: 'Inventory',
            edits: { '1:0': { value: 'Draft', base: 'Widget' } },
        });
        await controller_of(panel).drain();

        expect(state.get_state(file_path).pendingEdits?.[0]).toEqual({
            sheetName: 'Inventory',
            worksheetId: '2',
            cells: { '1:0': { value: 'Draft', base: 'Widget' } },
        });
        expect(panel.__messages).toContainEqual({
            type: 'pendingEditsAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
    });

    it('flushes the live editor before releasing a session whose edited sheets are gone', async () => {
        // The session's only durable work names a worksheet the reloaded workbook
        // no longer has. The replacement snapshot must reach the renderer before
        // release fences its final publication, or the newer live overlay is lost
        // and only this older committed draft survives.
        const state = versioned_state_store({
            pendingEdits: [
                undefined,
                {
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    cells: { '1:0': { value: 'Draft', base: 'Widget' } },
                },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        const session = latest_snapshot(panel).capabilities.csvEditSessionId!;

        bytes = drop_second_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        const flush_request = await worksheet_loss_flush_request(panel);
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
            edits: { '1:0': { value: 'Half typed', base: 'Widget' } },
        });
        await panel.__receive({
            type: 'pendingEditsFlush',
            requestId: flush_request!.requestId,
            editSessionId: session,
            highestProducedSequence: 1,
        });
        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSessionId === undefined,
        );

        // The old session id no longer buys a save on the surviving worksheet.
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Alice' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect((await parse_xlsx(bytes)).data.sheets[0].rows[1][0]?.raw).toBe('Alice');
        // The renderer's final live value survived the release in the parked slot.
        const parked = JSON.stringify(state.get_state(file_path).pendingEdits ?? null);
        expect(parked).toContain('Half typed');
        expect(parked).not.toContain('Draft');
    });

    it('flushes and releases a live-only session after its edited worksheet disappears', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'edit-inventory',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
        });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = drop_second_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        const flush_request = await worksheet_loss_flush_request(panel);
        await panel.__receive({
            type: 'pendingEditsFlush',
            requestId: flush_request!.requestId,
            editSessionId: session,
            highestProducedSequence: 0,
        });

        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSessionId === undefined,
        );
    });

    it('releases when the current clean target disappears despite an older visited sheet', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'edit-people',
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
        });
        const session = latest_edit_session(panel)!.editSessionId!;
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'edit-inventory',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
        });

        bytes = drop_second_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        const flush_request = await worksheet_loss_flush_request(panel);
        await panel.__receive({
            type: 'pendingEditsFlush',
            requestId: flush_request.requestId,
            editSessionId: session,
            highestProducedSequence: 0,
        });

        await wait_for_observable(
            () => latest_snapshot(panel).capabilities.csvEditSessionId === undefined,
        );
    });

    it('keeps a worksheet-loss session retargeted before its flush completes', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'edit-inventory',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
        });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = drop_second_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        const flush_request = await worksheet_loss_flush_request(panel);
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'retarget-people',
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
        });
        expect(latest_edit_session(panel)).toMatchObject({
            granted: true,
            editSessionId: session,
            sheetIndex: 0,
        });
        await panel.__receive({
            type: 'pendingEditsFlush',
            requestId: flush_request.requestId,
            editSessionId: session,
            highestProducedSequence: 0,
        });
        await controller_of(panel).drain();

        expect(latest_snapshot(panel).capabilities.csvEditSessionId).toBe(session);
    });

    it('keeps the session when a volatile target disappears but a durable target survives', async () => {
        const state = versioned_state_store({
            pendingEdits: [
                undefined,
                {
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    cells: { '1:0': { value: 'Draft', base: 'Widget' } },
                },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        const session = latest_snapshot(panel).capabilities.csvEditSessionId!;
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'observe-people',
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
        });

        bytes = drop_first_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');
        await controller_of(panel).drain();

        expect(latest_snapshot(panel).capabilities.csvEditSessionId).toBe(session);
        expect(panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'requestPendingEditsFlush'
            && String((message as { requestId?: unknown }).requestId)
                .startsWith('worksheet-loss:')
        ))).toBe(false);
        expect(sheet_cells(latest_snapshot(panel).state?.pendingEdits, 0))
            .toEqual({ '1:0': { value: 'Draft', base: 'Widget' } });
    });

    it('preserves deleted-sheet failed-save cleanup when a surviving sheet posts', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'edit-inventory',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
        });
        const session = latest_edit_session(panel)!.editSessionId!;
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            edits: { '1:0': { value: 'Bob', base: 'Alice' } },
        });
        await controller_of(panel).drain();

        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk is full');
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-inventory',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: false });

        bytes = drop_second_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel).length === 1);
        expect(latest_snapshot(panel).capabilities.csvEditSessionId).toBe(session);

        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 2,
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            edits: { '1:0': { value: 'Bobby', base: 'Alice' } },
        });
        await controller_of(panel).drain();
        await panel.__receive({ type: 'releaseEditSession', editSessionId: session });
        await controller_of(panel).drain();

        const pending = JSON.stringify(state.get_state(file_path).pendingEdits ?? null);
        expect(pending).toContain('Bobby');
        expect(pending).not.toContain('Gadget');
    });

    it('clears a failed name-only save\u2019s ID-tagged edits after its worksheet moves', async () => {
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        const started = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'saveOperationStarted'
        )) as { lifecycle: { operation: import('../types').CsvSaveOperation } };
        const failed = save_results(panel).at(-1)!;
        expect(started.lifecycle.operation.worksheets[0].worksheetId).toBeUndefined();
        expect(failed).toMatchObject({ success: false });
        expect(failed.lifecycle.operation.worksheets[0].worksheetId).toBeUndefined();
        expect(state.get_state(file_path).pendingEdits?.[1]).toEqual({
            sheetName: 'Inventory',
            worksheetId: '2',
            cells: { '1:0': { value: 'Gadget', base: 'Widget' } },
        });

        bytes = swap_sheet_order(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[0] === 'Inventory');

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

    it('clears a successful name-only save from its ID-tagged durable slot', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 1 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'name-only-success',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);
        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        await controller_of(panel).drain();

        expect(JSON.stringify(state.get_state(file_path).pendingEdits ?? null))
            .not.toContain('Gadget');
        expect((await parse_xlsx(bytes)).data.sheets[1].rows[1][0]?.raw).toBe('Gadget');
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
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
                saveRequestId: 'save-2',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > before);
    });

    it('clears every live slot after a reorder when a discard is retried', async () => {
        // The discard's durable clear fails, leaving the cleanup `uncertain`; the
        // retry runs whenever editing is next requested, which may be long after
        // an external reorder. The session covers the whole workbook, so the
        // discard the user confirmed covers every sheet it was showing — and
        // the retry must find those slots by name after the reorder, not clear
        // by stale positions.
        const state = versioned_state_store({
            pendingEdits: [
                { sheetName: 'People', cells: { '1:0': { value: 'Draft', base: 'Alice' } } },
                { sheetName: 'Inventory', cells: { '1:0': { value: 'Gadget', base: 'Widget' } } },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
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
        expect(JSON.stringify(state.get_state(file_path).pendingEdits ?? null))
            .not.toContain('Draft');
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: failed,
                }],
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: failed,
                }],
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: saved,
                }],
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: failed,
                }],
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget', '2:0': 'Shared' },
                    dirtyEdits: failed,
                }],
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: failed,
                }],
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


    it('rejects pending-edit posts without complete sheet identity for XLSX', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const identities = [
            {},
            { sheetIndex: 0 },
            { sheetName: 'People' },
        ];

        for (let index = 0; index < identities.length; index += 1) {
            const sequence = index + 1;
            const value = `rejected-${sequence}`;
            await panel.__receive({
                type: 'pendingEditsChanged',
                editSessionId: session,
                sequence,
                edits: { '0:0': { value, base: 'Alice' } },
                ...identities[index],
            });
            await controller_of(panel).drain();

            expect(JSON.stringify(state.get_state(file_path).pendingEdits ?? null))
                .not.toContain(value);
            expect(panel.__messages).not.toContainEqual({
                type: 'pendingEditsAcknowledged',
                editSessionId: session,
                sequence,
            });
        }

        // Rejected higher sequences do not poison the watermark: the first valid
        // publication is still admitted and acknowledged at sequence one.
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            sheetIndex: 0,
            sheetName: 'People',
            edits: { '0:0': { value: 'accepted', base: 'Alice' } },
        });
        await controller_of(panel).drain();
        expect(state.get_state(file_path).pendingEdits?.[0]).toMatchObject({
            sheetName: 'People',
            cells: { '0:0': { value: 'accepted', base: 'Alice' } },
        });
        expect(panel.__messages).toContainEqual({
            type: 'pendingEditsAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
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
            sheetIndex: 0,
            sheetName: 'People',
            edits: { '0:0': { value: 'Bob', base: 'Alice' } },
        });
        await controller_of(panel).drain();
        const durable = () => JSON.stringify(state.get_state(file_path).pendingEdits ?? []);
        await wait_for_observable(() => durable().includes('Bob'));

        // People's own draft is stored, and neither Inventory draft was lost.
        expect(durable()).toContain('Mallory');
        expect(durable()).toContain('Draft');
    });

    it('clears displaced drafts when the workbook session is discarded', async () => {
        // Discard is workbook-wide: the renderer clears live and parked stores, so
        // the host must also clear every durable slot or a removed/displaced draft
        // can reappear after the user explicitly discarded the session.
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

        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('keeps a durable draft when its worksheet is renamed externally', async () => {
        // Renaming a sheet in Excel with the file open made the draft's tag stop
        // resolving, and reconciliation dropped the slot — durably, so renaming it
        // back recovered nothing. A rename is not a deletion, and from the tag alone
        // the two are indistinguishable, so the draft has to survive.
        const state = versioned_state_store({
            pendingEdits: [
                undefined,
                {
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    cells: { '1:0': { value: 'Draft', base: 'Widget' } },
                },
            ],
        });
        const panel = await open_ready_xlsx(file_path, state);
        expect(sheet_names(panel)).toContain('Inventory');

        // Rename Inventory -> Stock in the workbook part, on disk, behind our back.
        bytes = rewrite_workbook_xml(bytes, (xml) =>
            xml.replace('name="Inventory"', 'name="Stock"'));

        await vscode_mock.__getWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel).includes('Stock'));
        await controller_of(panel).drain();

        const durable = JSON.stringify(state.get_state(file_path).pendingEdits ?? null);
        expect(durable, 'durable draft').toContain('Draft');
        const stock_index = sheet_names(panel).indexOf('Stock');
        expect(sheet_cells(
            latest_snapshot(panel).state?.pendingEdits,
            stock_index,
        )).toEqual({ '1:0': { value: 'Draft', base: 'Widget' } });
    });

    it('does not give a recreated same-name worksheet an old ID draft', async () => {
        const state = versioned_state_store({
            pendingEdits: [{
                sheetName: 'People',
                worksheetId: '1',
                cells: { '1:0': { value: 'Draft', base: 'Alice' } },
            }],
        });
        bytes = rewrite_workbook_xml(bytes, (xml) => {
            const rewritten = xml.replace(
                /(<sheet\b(?=[^>]*\bname="People")[^>]*\bsheetId=")1("[^>]*>)/,
                (_match, prefix: string, suffix: string) => `${prefix}99${suffix}`,
            );
            expect(rewritten).toMatch(
                /<sheet\b(?=[^>]*\bname="People")[^>]*\bsheetId="99"/,
            );
            return rewritten;
        });

        const panel = await open_ready_xlsx(file_path, state);
        expect(latest_snapshot(panel).capabilities.csvEditSessionId).toBeUndefined();
        expect(JSON.stringify(latest_snapshot(panel).state?.pendingEdits ?? null))
            .not.toContain('Draft');
        expect(JSON.stringify(state.get_state(file_path).pendingEdits ?? null))
            .toContain('Draft');
    });

    it('parks an outgoing old-ID flush after same-name replacement', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        bytes = rewrite_workbook_xml(bytes, (xml) => xml.replace(
            /(<sheet\b(?=[^>]*\bname="People")[^>]*\bsheetId=")1("[^>]*>)/,
            (_match, prefix: string, suffix: string) => `${prefix}99${suffix}`,
        ));

        await vscode_mock.__getWatchers()[0].__fireChange();
        await wait_for_observable(() => (
            latest_snapshot(panel).capabilities.csvEditSessionId === session
            && latest_snapshot(panel).meta.sheets[0]?.worksheetId === '99'
        ));

        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '99',
            edits: { '0:0': { value: 'current draft', base: 'Alice' } },
        });
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 2,
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            edits: { '1:0': { value: 'half-typed old draft', base: 'Alice' } },
        });
        await controller_of(panel).drain();

        const pending = state.get_state(file_path).pendingEdits ?? [];
        expect(pending.find((slot) => slot?.worksheetId === '99')).toEqual({
            sheetName: 'People',
            worksheetId: '99',
            cells: { '0:0': { value: 'current draft', base: 'Alice' } },
        });
        expect(pending.find((slot) => slot?.worksheetId === '1')).toEqual({
            sheetName: 'People',
            worksheetId: '1',
            cells: { '1:0': { value: 'half-typed old draft', base: 'Alice' } },
        });
        expect(panel.__messages).toContainEqual({
            type: 'pendingEditsAcknowledged',
            editSessionId: session,
            sequence: 2,
        });
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
        expect(snapshot.capabilities.csvEditSessionId).toBeDefined();
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
            && JSON.stringify(latest_snapshot(panel).state?.pendingEdits ?? null)
                .includes('Real')
        ));

        const projected = JSON.stringify(latest_snapshot(panel).state?.pendingEdits ?? null);
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
                saveRequestId: 'save-1',
                worksheets: [{
                    sheetIndex: 1,
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    edits: { '1:0': 'Gadget' },
                    dirtyEdits: { '1:0': { value: 'Gadget', base: 'Widget' } },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(read_part(bytes, 'xl/styles.xml')).toEqual(styles_before);
    });
});

function rewrite_workbook_xml(
    zip: Uint8Array,
    transform: (xml: string) => string,
): Uint8Array {
    const file = CFB.read(zip, { type: 'buffer' });
    const entry = CFB.find(file, '/xl/workbook.xml')!;
    const rewritten = Buffer.from(
        transform(Buffer.from(entry.content as Uint8Array).toString('utf8')),
        'utf8',
    );
    entry.content = rewritten;
    entry.size = rewritten.length;
    const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
    return written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike);
}

/**
 * Swap the two `<sheet>` entries in the workbook part.
 *
 * The parts themselves are untouched, which is what an external reorder looks
 * like: the same worksheet XML, listed the other way round, so index 0 and index
 * 1 now name each other's sheet.
 */
function swap_sheet_order(zip: Uint8Array): Uint8Array {
    return rewrite_workbook_xml(zip, (xml) => {
        const sheets = [...xml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
        expect(sheets).toHaveLength(2);
        return xml.replace(sheets[0] + sheets[1], sheets[1] + sheets[0]);
    });
}

/** Drop the first `<sheet>` entry, as deleting that worksheet elsewhere would. */
function drop_first_sheet(zip: Uint8Array): Uint8Array {
    return rewrite_workbook_xml(zip, (xml) => {
        const sheets = [...xml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
        expect(sheets).toHaveLength(2);
        return xml.replace(sheets[0], '');
    });
}

/** Drop the second `<sheet>` entry, as deleting that worksheet elsewhere would. */
function drop_second_sheet(zip: Uint8Array): Uint8Array {
    return rewrite_workbook_xml(zip, (xml) => {
        const sheets = [...xml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
        expect(sheets).toHaveLength(2);
        return xml.replace(sheets[1], '');
    });
}

function read_part(zip: Uint8Array, part: string): Buffer | null {
    const entry = CFB.find(CFB.read(zip, { type: 'buffer' }), `/${part}`);
    return entry?.content ? Buffer.from(entry.content as Uint8Array) : null;
}
