// Row and column structure through the VS Code extension host (row and column
// structure design, "Integration and desktop smoke"). The real webview is
// loaded and acknowledges every snapshot; the test speaks the webview protocol
// itself to admit inserts, publish a layout, and save, then reads the file.
// The desktop smoke specs drive the same webview by mouse and keyboard.
//
// Structural editing ships behind `STRUCTURAL_EDITING_ENABLED`; the test turns
// it on for the viewers it opens through the extension's test API.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TableViewerIntegrationSession } from '../custom-editor';
import type { PendingAppendedRow, PendingColumn } from '../pending-changes';
import { parse_xlsx } from '../parse-xlsx';
import type { HostMessage, WebviewMessage, WorksheetPendingChanges } from '../types';
import type { ColumnLayout, RowLayout } from '../worksheet-layout';
import {
    close_all_editors,
    fixture_uri,
    has_custom_tab,
    integration_api,
    open_session,
    wait_for,
    wait_for_latest_snapshot_ack,
    wait_for_message,
    type SnapshotMessage,
} from './helpers';

type InsertResult = Extract<HostMessage, { type: 'structuralInsertResult' }>;
type SaveResult = Extract<HostMessage, { type: 'saveResult' }>;

/** One open worksheet in Edit mode, driven through the webview protocol. */
class StructuralDriver {
    #sequence = 0;
    #requests = 0;

    private constructor(
        readonly session: TableViewerIntegrationSession,
        readonly edit_session_id: string,
        readonly target: { sheetIndex: number; sheetName: string; worksheetId?: string },
    ) {}

    static async open(uri: vscode.Uri): Promise<{ driver: StructuralDriver; initial: SnapshotMessage }> {
        const { session, initial } = await open_session(uri);
        const sheet = initial.snapshot.meta.sheets[0];
        const target = {
            sheetIndex: 0,
            sheetName: sheet.name,
            ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
        };
        const request_id = `edit:${Date.now()}`;
        await session.receive({ type: 'requestEditSession', requestId: request_id, ...target });
        const edit = await wait_for_message(
            session,
            (message): message is Extract<HostMessage, { type: 'editSessionResult' }> =>
                message.type === 'editSessionResult' && message.requestId === request_id,
            'an edit-session grant',
        );
        assert.strictEqual(edit.granted, true, 'the workflow must enter Edit mode');
        return { driver: new StructuralDriver(session, edit.editSessionId!, target), initial };
    }

    latest(): SnapshotMessage {
        const snapshot = this.session.messages().filter(
            (message): message is SnapshotMessage => message.type === 'workbookSnapshot',
        ).at(-1);
        assert.ok(snapshot, 'a workbook snapshot');
        return snapshot;
    }

    /** Admit an insert and settle it as installed. */
    async insert(axis: 'rows' | 'columns', anchor: unknown): Promise<InsertResult> {
        this.#requests += 1;
        const request_id = `insert:${axis}:${this.#requests}`;
        await this.session.receive({
            type: 'requestStructuralInsert',
            requestId: request_id,
            editSessionId: this.edit_session_id,
            worksheet: this.target,
            sourceGeneration: this.latest().snapshot.sourceGeneration,
            axis,
            anchor,
            side: 'after',
            count: 1,
        } as WebviewMessage);
        const result = await wait_for_message(
            this.session,
            (message): message is InsertResult =>
                message.type === 'structuralInsertResult' && message.requestId === request_id,
            `the ${axis} insert admission`,
        );
        assert.strictEqual(result.granted, true, result.reason ?? 'insert refused');
        await this.session.receive({
            type: 'settleRowAdmission',
            requestId: request_id,
            editSessionId: this.edit_session_id,
            accepted: true,
        });
        return result;
    }

    /** Publish the worksheet's Pending Changes; whether the host acknowledged them. */
    async publish(changes: Omit<WorksheetPendingChanges, 'sheetIndex' | 'sheetName' | 'worksheetId'>): Promise<boolean> {
        this.#sequence += 1;
        const sequence = this.#sequence;
        await this.session.receive({
            type: 'pendingChangesChanged',
            changes: { ...this.target, ...changes },
            editSessionId: this.edit_session_id,
            sequence,
            sourceGeneration: this.latest().snapshot.sourceGeneration,
        });
        const acknowledged = await wait_for(() => this.session.messages().some((message) =>
            message.type === 'pendingChangesAcknowledged'
            && message.editSessionId === this.edit_session_id
            && message.sequence === sequence), 20_000, 20);
        if (acknowledged) await wait_for_latest_snapshot_ack(this.session);
        return acknowledged;
    }

    async save(structural: Omit<WorksheetPendingChanges, 'sheetIndex' | 'sheetName' | 'worksheetId'>): Promise<SaveResult> {
        this.#requests += 1;
        const save_request_id = `save:${this.#requests}`;
        await this.session.receive({
            type: 'saveCsv',
            operation: {
                editSessionId: this.edit_session_id,
                saveRequestId: save_request_id,
                worksheets: [{
                    ...this.target,
                    edits: {},
                    dirtyEdits: {},
                    structuralChanges: { ...this.target, ...structural },
                }],
            },
        });
        return wait_for_message(
            this.session,
            (message): message is SaveResult => message.type === 'saveResult'
                && 'operation' in message.lifecycle
                && message.lifecycle.operation.saveRequestId === save_request_id,
            'the structural save result',
        );
    }
}

/**
 * Insert a row after the first body row, then lay out
 * `[second, inserted, first (removed), rest…]` and
 * `[column 1, column 0, inserted, column 2 (removed), rest…]`:
 * every operation on both axes in one publication.
 */
async function structural_changes(
    driver: StructuralDriver,
    shape: { bodyStart: number; bodyRows: number; columns: number; xlsx: boolean },
): Promise<Omit<WorksheetPendingChanges, 'sheetIndex' | 'sheetName' | 'worksheetId'>> {
    const first = shape.bodyStart;
    const rows = await driver.insert('rows', { row: { kind: 'source', sourceRow: first } });
    const columns = await driver.insert('columns', { column: { kind: 'source', sourceColumn: 0 } });
    const row_id = rows.rowIds![0];
    const column_id = columns.columnIds![0];
    const inserted_row: PendingAppendedRow = {
        id: row_id,
        origin: 'insert',
        cells: { 0: { value: 'Dana' } },
        formatTemplateId: rows.formatTemplate!.id,
        createdOrder: 1,
    };
    const inserted_column: PendingColumn = {
        id: column_id,
        header: 'Note',
        cells: { [`s:${first + 1}`]: { value: 'tall' }, [`p:${row_id}`]: { value: 'new' } },
        format: shape.xlsx ? { kind: 'source', sourceColumn: 0 } : { kind: 'none' },
        createdOrder: 1,
    };
    const rest = shape.bodyRows - 2;
    const row_layout: RowLayout = {
        runs: [
            { kind: 'source', start: first + 1, count: 1 },
            { kind: 'pending', ids: [row_id] },
            { kind: 'source', start: first, count: 1 },
            ...(rest > 0 ? [{ kind: 'source' as const, start: first + 2, count: rest }] : []),
        ],
        removedSourceRows: [{ start: first, count: 1 }],
        discardedPendingRows: [],
    };
    const column_layout: ColumnLayout = {
        columns: [
            { kind: 'source', sourceColumn: 1 },
            { kind: 'source', sourceColumn: 0 },
            { kind: 'pending', pendingColumnId: column_id },
            ...Array.from({ length: shape.columns - 2 }, (_, index) =>
                ({ kind: 'source' as const, sourceColumn: index + 2 })),
        ],
        removedSourceColumns: [2],
        discardedPendingColumns: [],
    };
    return {
        cells: {},
        formatTemplates: [rows.formatTemplate!],
        appendedRows: [inserted_row],
        tailRemovals: [],
        appendBasis: rows.appendBasis!,
        conflicts: [],
        rowLayout: row_layout,
        columnLayout: column_layout,
        pendingColumns: [inserted_column],
        structuralBasis: rows.structuralBasis!,
    };
}

describe('row and column structure in the VS Code extension host', () => {
    let root: string;

    before(async () => {
        (await integration_api()).setStructuralEditingEnabled(true);
    });

    after(async () => {
        (await integration_api()).setStructuralEditingEnabled(undefined);
    });

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'table-viewer-structure-integration-'));
    });

    afterEach(async () => {
        await close_all_editors();
        await wait_for(() => !has_custom_tab('tableViewer.editor'), 10_000, 20);
        await fs.rm(root, { recursive: true, force: true });
    });

    for (const test_case of [
        {
            fixture: 'basic.csv',
            expected: 'Age,Name,Note\n25,Bob,tall\n,Dana,new\n35,Charlie,\n',
        },
        {
            fixture: 'basic.tsv',
            expected: 'Age\tName\tNote\n25\tBob\ttall\n\tDana\tnew\n35\tCharlie\t\n',
        },
    ]) {
        it(`inserts, deletes, moves, and saves rows and columns in ${test_case.fixture}`, async () => {
            const file = path.join(root, test_case.fixture);
            await fs.copyFile(fixture_uri(test_case.fixture).fsPath, file);
            const { driver, initial } = await StructuralDriver.open(vscode.Uri.file(file));
            const support = initial.snapshot.capabilities.structuralEditing?.sheets[0];
            assert.strictEqual(support?.rows.supported, true);
            assert.strictEqual(support?.columns.supported, true);

            const changes = await structural_changes(driver, {
                bodyStart: 0, bodyRows: 3, columns: 3, xlsx: false,
            });
            assert.ok(await driver.publish(changes), 'the host acknowledges the layout');
            const saved = await driver.save(changes);
            assert.strictEqual(saved.success, true, JSON.stringify(saved));
            assert.strictEqual(await fs.readFile(file, 'utf8'), test_case.expected);
        });
    }

    it('inserts, deletes, moves, and saves rows and columns in basic.xlsx under its detected Header Row', async () => {
        const file = path.join(root, 'basic.xlsx');
        await fs.copyFile(fixture_uri('basic.xlsx').fsPath, file);
        const { driver, initial } = await StructuralDriver.open(vscode.Uri.file(file));
        const sheet = initial.snapshot.meta.sheets[0];
        assert.strictEqual(sheet.excelFirstRowHeader?.active, true);
        const support = initial.snapshot.capabilities.structuralEditing?.sheets[0];
        assert.strictEqual(support?.rows.supported, true, JSON.stringify(support?.rows));
        assert.strictEqual(support?.columns.supported, true, JSON.stringify(support?.columns));

        const changes = await structural_changes(driver, {
            bodyStart: 1, bodyRows: 2, columns: 4, xlsx: true,
        });
        assert.ok(await driver.publish(changes), 'the host acknowledges the layout');
        const saved = await driver.save(changes);
        assert.strictEqual(saved.success, true, JSON.stringify(saved));
        const parsed = await parse_xlsx(new Uint8Array(await fs.readFile(file)));
        assert.deepStrictEqual(
            parsed.data.sheets[0].rows.map((row) => row.map((cell) => cell?.formatted ?? '')),
            [
                ['Age', 'Name', 'Note', 'Joined'],
                ['25', 'Bob', 'tall', '6/1/23'],
                ['', 'Dana', 'new', ''],
            ],
        );
    });

    it('restores unsaved structural drafts after the editor closes and reopens', async () => {
        const file = path.join(root, 'basic.csv');
        await fs.copyFile(fixture_uri('basic.csv').fsPath, file);
        const before = await fs.readFile(file, 'utf8');
        const { driver } = await StructuralDriver.open(vscode.Uri.file(file));
        const changes = await structural_changes(driver, {
            bodyStart: 0, bodyRows: 3, columns: 3, xlsx: false,
        });
        assert.ok(await driver.publish(changes));

        await close_all_editors();
        assert.ok(await wait_for(() => !has_custom_tab('tableViewer.editor'), 10_000, 20));
        assert.strictEqual(await fs.readFile(file, 'utf8'), before, 'closing writes nothing');

        const { initial } = await open_session(vscode.Uri.file(file));
        const restored = initial.snapshot.state.pendingEdits?.[0];
        assert.deepStrictEqual(restored?.rowLayout, changes.rowLayout);
        assert.deepStrictEqual(restored?.columnLayout, changes.columnLayout);
        assert.deepStrictEqual(restored?.pendingColumns?.map((column) => column.header), ['Note']);
        assert.deepStrictEqual(restored?.appendedRows?.map((row) => row.cells), [{ 0: { value: 'Dana' } }]);
    });

    /** Publish a layout, then rewrite a value in place: not rows appended on disk. */
    async function conflicted_session() {
        const file = path.join(root, 'basic.csv');
        await fs.copyFile(fixture_uri('basic.csv').fsPath, file);
        const { driver } = await StructuralDriver.open(vscode.Uri.file(file));
        const changes = await structural_changes(driver, {
            bodyStart: 0, bodyRows: 3, columns: 3, xlsx: false,
        });
        assert.ok(await driver.publish(changes));
        const changed = 'Name,Age,City\nAlice,31,New York\nBob,25,London\nCharlie,35,Paris\n';
        await fs.writeFile(file, changed);
        const conflicted = await wait_for_message(
            driver.session,
            (message): message is SnapshotMessage => message.type === 'workbookSnapshot'
                && (message.snapshot.state.pendingEdits?.[0]?.conflicts ?? [])
                    .some((conflict) => conflict.reason === 'structuralBasisChanged'),
            'a structuralBasisChanged conflict',
        );
        await wait_for_latest_snapshot_ack(driver.session);
        const refused = await driver.save({
            ...changes,
            conflicts: conflicted.snapshot.state.pendingEdits![0]!.conflicts ?? [],
        });
        assert.strictEqual(refused.success, false, 'Save is refused while the conflict stands');
        assert.strictEqual(await fs.readFile(file, 'utf8'), changed);
        return { file, driver, changes, changed };
    }

    it('flags an external change, then keeps the new rows at the end', async () => {
        const { file, driver, changes, changed } = await conflicted_session();
        // The inserted row becomes an appended row; the layout, the Pending
        // Column, and the Structural Basis are dropped.
        const kept: Omit<WorksheetPendingChanges, 'sheetIndex' | 'sheetName' | 'worksheetId'> = {
            cells: {},
            formatTemplates: changes.formatTemplates,
            appendedRows: [{ ...changes.appendedRows[0], origin: 'append', createdOrder: 2 }],
            tailRemovals: [],
            appendBasis: changes.appendBasis,
            conflicts: [],
        };
        assert.ok(await driver.publish(kept), 'the host accepts the kept rows as appended');
        assert.deepStrictEqual(driver.latest().snapshot.state.pendingEdits?.[0]?.conflicts ?? [], []);
        const saved = await driver.save(kept);
        assert.strictEqual(saved.success, true, JSON.stringify(saved));
        assert.strictEqual(await fs.readFile(file, 'utf8'), `${changed}Dana,,\n`);
    });

    it('flags an external change, then discards the row and column changes', async () => {
        const { file, driver, changed } = await conflicted_session();
        assert.ok(await driver.publish({
            cells: {},
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        }), 'the host accepts the discard');
        const pending = driver.latest().snapshot.state.pendingEdits?.[0];
        assert.strictEqual(pending?.rowLayout, undefined);
        assert.strictEqual(pending?.columnLayout, undefined);
        assert.deepStrictEqual(pending?.conflicts ?? [], []);
        assert.strictEqual(await fs.readFile(file, 'utf8'), changed);
    });
});
