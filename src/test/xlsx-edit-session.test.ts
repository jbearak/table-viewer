import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, profile_for } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import CFB from 'cfb';
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

async function flush_promises(): Promise<void> {
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

function open_xlsx(file_path: string) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        uri(file_path),
        with_in_memory_authority_transactions(versioned_state_store({}).store),
        profile_for(file_path),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function latest_snapshot(panel: { __messages: unknown[] }) {
    const message = [...panel.__messages].reverse().find((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && (candidate as { type?: unknown }).type === 'workbookSnapshot'
    )) as { snapshot: { identity: unknown } };
    return message.snapshot;
}

/** Open, and acknowledge the first snapshot: a save refuses until the webview
 *  has confirmed it is looking at the bytes the save will be validated against. */
async function open_ready_xlsx(file_path: string) {
    const panel = open_xlsx(file_path);
    await panel.__receive({ type: 'ready' });
    // The source build is async, so the first snapshot lands a few turns after
    // `ready` resolves.
    await flush_promises();
    await panel.__receive({
        type: 'snapshotApplied',
        identity: latest_snapshot(panel).identity,
        disposition: 'applied',
    });
    return panel;
}

function latest_edit_session(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is { type: string; granted: boolean; editSessionId?: string } => (
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
        await flush_promises();

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[1].rows[1][0]?.raw).toBe('Gadget');
        // The sibling worksheet is untouched, which is the whole point of the
        // worksheet being the edited object.
        expect(after.data.sheets[0].rows[1][0]?.raw).toBe(people_before);
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
        await flush_promises();

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            rejection: { reason: 'baseMismatch' },
        });
        expect(bytes).toBe(untouched);
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
        await flush_promises();

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(read_part(bytes, 'xl/styles.xml')).toEqual(styles_before);
    });
});

function read_part(zip: Uint8Array, part: string): Buffer | null {
    const entry = CFB.find(CFB.read(zip, { type: 'buffer' }), `/${part}`);
    return entry?.content ? Buffer.from(entry.content as Uint8Array) : null;
}
