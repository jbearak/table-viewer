import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TableViewerIntegrationSession } from '../custom-editor';
import type { HostMessage, WebviewMessage, WorksheetPendingChanges } from '../types';
import {
    close_all_editors,
    fixture_uri,
    has_custom_tab,
    integration_api,
    wait_for,
} from './helpers';

type SnapshotMessage = Extract<HostMessage, { type: 'workbookSnapshot' }>;

function run_git(directory: string, args: readonly string[]): void {
    execFileSync('git', [...args], {
        cwd: directory,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Table Viewer Integration',
            GIT_AUTHOR_EMAIL: 'integration@example.invalid',
            GIT_COMMITTER_NAME: 'Table Viewer Integration',
            GIT_COMMITTER_EMAIL: 'integration@example.invalid',
        },
        stdio: 'pipe',
    });
}

async function wait_for_message<T extends HostMessage>(
    session: TableViewerIntegrationSession,
    predicate: (message: HostMessage) => message is T,
    description: string,
): Promise<T> {
    let found: T | undefined;
    const observed = await wait_for(() => {
        found = [...session.messages()].reverse().find(predicate);
        return found !== undefined;
    }, 20_000, 20);
    assert.ok(observed && found, `timed out waiting for ${description}`);
    return found;
}

async function wait_for_latest_snapshot_ack(
    session: TableViewerIntegrationSession,
): Promise<SnapshotMessage> {
    let latest: SnapshotMessage | undefined;
    const acknowledged = await wait_for(() => {
        latest = session.messages().filter(
            (message): message is SnapshotMessage => message.type === 'workbookSnapshot',
        ).at(-1);
        return latest !== undefined && session.receivedMessages().some((message) =>
            message.type === 'snapshotApplied'
            && message.identity.deliveryId === latest?.snapshot.identity.deliveryId);
    }, 20_000, 20);
    assert.ok(acknowledged && latest, 'the real webview must acknowledge the latest snapshot');
    return latest;
}

async function open_session(uri: vscode.Uri): Promise<{
    session: TableViewerIntegrationSession;
    initial: SnapshotMessage;
}> {
    const api = await integration_api();
    await vscode.commands.executeCommand('vscode.openWith', uri, 'tableViewer.editor');
    assert.ok(
        await wait_for(() => has_custom_tab('tableViewer.editor'), 20_000, 20),
        `expected a custom editor for ${path.basename(uri.fsPath)}`,
    );
    let session: TableViewerIntegrationSession | undefined;
    assert.ok(await wait_for(() => {
        session = api.integrationSession(uri);
        return session !== undefined;
    }, 20_000, 20), `expected an integration session for ${uri.fsPath}`);
    const initial = await wait_for_message(
        session!,
        (message): message is SnapshotMessage => message.type === 'workbookSnapshot'
            && message.snapshot.presentation === 'initial',
        'the initial workbook snapshot',
    );
    await wait_for_latest_snapshot_ack(session!);
    return { session: session!, initial };
}

async function append_blank_row_and_save(
    session: TableViewerIntegrationSession,
    snapshot_message: SnapshotMessage,
    sheet_index: number,
): Promise<Extract<HostMessage, { type: 'saveResult' }>> {
    const snapshot = snapshot_message.snapshot;
    const sheet = snapshot.meta.sheets[sheet_index];
    assert.ok(sheet, `worksheet ${sheet_index} exists`);
    const target = {
        sheetIndex: sheet_index,
        sheetName: sheet.name,
        ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
    };
    const edit_request_id = `edit:${sheet_index}`;
    await session.receive({
        type: 'requestEditSession',
        requestId: edit_request_id,
        ...target,
    });
    const edit = await wait_for_message(
        session,
        (message): message is Extract<HostMessage, { type: 'editSessionResult' }> =>
            message.type === 'editSessionResult' && message.requestId === edit_request_id,
        'an edit-session grant',
    );
    assert.strictEqual(edit.granted, true, 'the integration workflow must enter Edit mode');
    assert.ok(edit.editSessionId, 'the edit-session grant must carry its identity');

    const append_request_id = `append:${sheet_index}`;
    await session.receive({
        type: 'requestAppendRows',
        requestId: append_request_id,
        editSessionId: edit.editSessionId,
        worksheet: target,
        sourceGeneration: snapshot.sourceGeneration,
        count: 1,
    });
    const admission = await wait_for_message(
        session,
        (message): message is Extract<HostMessage, { type: 'appendRowsResult' }> =>
            message.type === 'appendRowsResult' && message.requestId === append_request_id,
        'an append-row admission',
    );
    assert.strictEqual(admission.granted, true, admission.reason ?? 'append admission refused');
    assert.strictEqual(admission.rowIds?.length, 1);
    assert.ok(admission.formatTemplate);
    assert.ok(admission.appendBasis);
    await session.receive({
        type: 'settleRowAdmission',
        requestId: append_request_id,
        editSessionId: edit.editSessionId,
        accepted: true,
    });

    const structural: WorksheetPendingChanges = {
        ...target,
        cells: {},
        formatTemplates: [admission.formatTemplate],
        appendedRows: [{
            id: admission.rowIds[0],
            cells: {},
            formatTemplateId: admission.formatTemplate.id,
            createdOrder: 1,
        }],
        tailRemovals: [],
        appendBasis: admission.appendBasis,
        conflicts: [],
    };
    await session.receive({
        type: 'pendingChangesChanged',
        changes: structural,
        editSessionId: edit.editSessionId,
        sequence: 1,
        sourceGeneration: snapshot.sourceGeneration,
    });
    await wait_for_message(
        session,
        (message): message is Extract<HostMessage, { type: 'pendingChangesAcknowledged' }> =>
            message.type === 'pendingChangesAcknowledged'
                && message.editSessionId === edit.editSessionId
                && message.sequence === 1,
        'the durable Pending Changes acknowledgement',
    );
    await wait_for_latest_snapshot_ack(session);
    const save_request_id = `save:${sheet_index}`;
    const save: WebviewMessage = {
        type: 'saveCsv',
        operation: {
            editSessionId: edit.editSessionId,
            saveRequestId: save_request_id,
            worksheets: [{
                ...target,
                edits: {},
                dirtyEdits: {},
                structuralChanges: structural,
            }],
        },
    };
    await session.receive(save);
    const result = await wait_for_message(
        session,
        (message): message is Extract<HostMessage, { type: 'saveResult' }> =>
            message.type === 'saveResult'
                && 'operation' in message.lifecycle
                && message.lifecycle.operation.saveRequestId === save_request_id,
        'the append save result',
    );
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.deepStrictEqual(
        result.receipt?.appendedRows.map((row) => row.pendingRowId),
        admission.rowIds,
    );
    return result;
}

describe('append-row workflows in the VS Code extension host', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'table-viewer-append-integration-'));
    });

    afterEach(async () => {
        await close_all_editors();
        await wait_for(() => !has_custom_tab('tableViewer.editor'), 10_000, 20);
        await fs.rm(root, { recursive: true, force: true });
    });

    for (const test_case of [
        { fixture: 'basic.csv', sheets: 1 },
        { fixture: 'basic.tsv', sheets: 1 },
        { fixture: 'formatted.xlsx', sheets: 1 },
        { fixture: 'basic.xlsx', sheets: 2 },
    ]) {
        it(`appends, saves, and detects git reset for ${test_case.fixture}`, async () => {
            const target_path = path.join(root, test_case.fixture);
            await fs.copyFile(fixture_uri(test_case.fixture).fsPath, target_path);
            run_git(root, ['init', '--quiet']);
            run_git(root, ['add', '--', test_case.fixture]);
            run_git(root, ['commit', '--quiet', '-m', 'baseline']);

            const target = vscode.Uri.file(target_path);
            const { session, initial } = await open_session(target);
            assert.strictEqual(initial.snapshot.meta.sheets.length, test_case.sheets);
            const original_row_count = initial.snapshot.meta.sheets[0].rowCount;
            await append_blank_row_and_save(session, initial, 0);

            const saved = await wait_for_message(
                session,
                (message): message is SnapshotMessage => message.type === 'workbookSnapshot'
                    && message.snapshot.presentation === 'refresh'
                    && message.snapshot.meta.sheets[0].rowCount === original_row_count + 1,
                'the saved workbook snapshot with one new row',
            );
            assert.strictEqual(saved.snapshot.meta.sheets.length, test_case.sheets);
            await wait_for_latest_snapshot_ack(session);

            run_git(root, ['reset', '--hard', '--quiet', 'HEAD']);
            const restored = await wait_for_message(
                session,
                (message): message is SnapshotMessage => message.type === 'workbookSnapshot'
                    && message.snapshot.reason === 'fileReload'
                    && message.snapshot.meta.sheets[0].rowCount === original_row_count,
                'the fileReload snapshot after git reset --hard',
            );
            assert.strictEqual(restored.snapshot.meta.sheets.length, test_case.sheets);
        });
    }
});
