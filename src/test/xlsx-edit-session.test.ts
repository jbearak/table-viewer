import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, profile_for } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import CFB from 'cfb';
import {
    decode_stored_per_file_state,
    own_wire_pending_changes,
    type PerFileState,
    type SheetPendingEditCells,
    type WorksheetTarget,
} from '../types';
import { parse_xlsx } from '../parse-xlsx';
import { capture_xlsx_append_row_format } from '../xlsx-package';
import {
    MAX_PENDING_CHANGES_ENCODED_BYTES,
    MAX_PENDING_USER_CHANGES_ENCODED_BYTES,
    type PendingStructuralChanges,
} from '../pending-changes';
import { HISTORY_REPLAY_LEASE_TTL_MS } from '../history-replay-protocol';
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

function build_many_sheet_xlsx(sheet_count: number): Uint8Array {
    const package_file = CFB.utils.cfb_new();
    const sheet_overrides = Array.from({ length: sheet_count }, (_, index) =>
        `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('\n');
    const content_types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheet_overrides}
</Types>`;
    const root_relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const workbook_sheets = Array.from({ length: sheet_count }, (_, index) =>
        `<sheet name="S${index}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join('');
    const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${workbook_sheets}</sheets>
</workbook>`;
    const workbook_relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${Array.from({ length: sheet_count }, (_, index) =>
        `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
        .join('\n')}
</Relationships>`;
    const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>base</t></is></c></row></sheetData>
</worksheet>`;
    CFB.utils.cfb_add(package_file, '/[Content_Types].xml', Buffer.from(content_types));
    CFB.utils.cfb_add(package_file, '/_rels/.rels', Buffer.from(root_relationships));
    CFB.utils.cfb_add(package_file, '/xl/workbook.xml', Buffer.from(workbook));
    CFB.utils.cfb_add(
        package_file,
        '/xl/_rels/workbook.xml.rels',
        Buffer.from(workbook_relationships),
    );
    for (let index = 0; index < sheet_count; index += 1) {
        CFB.utils.cfb_add(
            package_file,
            `/xl/worksheets/sheet${index + 1}.xml`,
            Buffer.from(worksheet),
        );
    }
    const written = CFB.write(package_file, {
        type: 'buffer',
        fileType: 'zip',
        compression: true,
    });
    return written instanceof Uint8Array
        ? written
        : new Uint8Array(written as ArrayBufferLike);
}

function build_repeated_shared_string_xlsx(cell_count: number, value: string): Uint8Array {
    const package_file = CFB.utils.cfb_new();
    const content_types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;
    const root_relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Repeated" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
    const workbook_relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;
    const rows = Array.from({ length: cell_count }, (_, row) =>
        `<row r="${row + 1}"><c r="A${row + 1}" t="s"><v>0</v></c></row>`)
        .join('');
    const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A${cell_count}"/><sheetData>${rows}</sheetData>
</worksheet>`;
    const shared_strings = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${cell_count}" uniqueCount="1"><si><t>${value}</t></si></sst>`;
    for (const [part, content] of [
        ['/[Content_Types].xml', content_types],
        ['/_rels/.rels', root_relationships],
        ['/xl/workbook.xml', workbook],
        ['/xl/_rels/workbook.xml.rels', workbook_relationships],
        ['/xl/worksheets/sheet1.xml', worksheet],
        ['/xl/sharedStrings.xml', shared_strings],
    ] as const) {
        CFB.utils.cfb_add(package_file, part, Buffer.from(content));
    }
    const written = CFB.write(package_file, {
        type: 'buffer', fileType: 'zip', compression: true,
    });
    return written instanceof Uint8Array
        ? written
        : new Uint8Array(written as ArrayBufferLike);
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
        presentation: 'initial' | 'refresh';
        reason: string;
        capabilities: { csvEditSessionId?: string };
        meta: { sheets: {
            name: string;
            worksheetId?: string;
            rowCount: number;
            sourceRowCount: number;
            columnCount: number;
            excelFirstRowHeader?: { active: boolean; sourceRow?: number };
        }[] };
        state?: PerFileState;
    };
}

function refresh_snapshots(panel: { __messages: unknown[] }) {
    return panel.__messages.flatMap((message) => {
        if (
            typeof message !== 'object'
            || message === null
            || (message as { type?: unknown }).type !== 'workbookSnapshot'
        ) return [];
        const snapshot = (message as { snapshot: ReturnType<typeof latest_snapshot> }).snapshot;
        return snapshot.presentation === 'refresh' ? [snapshot] : [];
    });
}

function source_refresh_snapshots(panel: { __messages: unknown[] }) {
    return refresh_snapshots(panel).filter((snapshot) => snapshot.reason !== 'other');
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

async function request_edit_session_when_available(
    panel: { __messages: unknown[]; __receive(message: unknown): Promise<void> },
    request_prefix: string,
    sheet_index = 0,
): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const requestId = `${request_prefix}-${attempt}`;
        await panel.__receive({
            type: 'requestEditSession',
            requestId,
            sheetIndex: sheet_index,
        });
        const result = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'editSessionResult'
            && (message as { requestId?: unknown }).requestId === requestId
        )) as { granted?: boolean; editSessionId?: string } | undefined;
        if (result?.granted && result.editSessionId !== undefined) {
            return result.editSessionId;
        }
        await new Promise((done) => { setImmediate(done); });
    }
    throw new Error('Edit session did not become available.');
}

function save_results(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is {
            type: string;
            success: boolean;
            lifecycle: { operation: import('../types').CsvSaveOperation };
            receipt?: import('../types').PendingChangesSaveReceipt;
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

    const STYLED_A2 = '<c r="A2" t="inlineStr"><is>'
        + '<r><t>Al</t></r><r><rPr><b/></rPr><t>ice</t></r>'
        + '</is></c>';

    function cell_xml_a2(zip: Uint8Array): string | undefined {
        return read_part(zip, 'xl/worksheets/sheet1.xml')!
            .toString('utf8').match(/<c r="A2"[^>]*>[\s\S]*?<\/c>/)?.[0];
    }

    async function patch_styled_a2() {
        const file = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const source = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const patched = Buffer.from(
            source.replace('<c r="A2" t="s"><v>4</v></c>', STYLED_A2),
            'utf8',
        );
        sheet.content = patched;
        sheet.size = patched.length;
        const written = CFB.write(file, {
            type: 'buffer',
            fileType: 'zip',
            compression: true,
        });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const before = await parse_xlsx(bytes);
        const before_cell = before.data.sheets[0].rows[1][0]!;
        expect(before_cell.richText).toBeDefined();
        expect(cell_xml_a2(bytes)).toBe(STYLED_A2);
        return {
            before,
            before_cell,
            base_text: String(before_cell.raw ?? ''),
            cell_xml_before: STYLED_A2,
        };
    }

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

    async function prepare_saved_row_restoration(
        panel: Awaited<ReturnType<typeof open_ready_xlsx>>,
        prefix: string,
    ) {
        await panel.__receive({
            type: 'requestEditSession',
            requestId: `${prefix}-append-edit`,
            sheetIndex: 0,
        });
        const append_session = latest_edit_session(panel)!.editSessionId!;
        const initial = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: `${prefix}-append`,
            editSessionId: append_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: initial.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === `${prefix}-append`
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: `${prefix}-append`,
            editSessionId: append_session,
            accepted: true,
        });
        const original_row = {
            id: admission.rowIds![0],
            cells: { 0: { value: `${prefix}-saved`, valueEditOrder: 1 } },
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        };
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                append_session,
                `${prefix}-save-append`,
                save_worksheet({
                    edits: {},
                    dirtyEdits: {},
                    structuralChanges: {
                        formatTemplates: [admission.formatTemplate!],
                        appendedRows: [original_row],
                        tailRemovals: [],
                        appendBasis: admission.appendBasis!,
                        conflicts: [],
                    },
                }),
            ),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle.operation.saveRequestId === `${prefix}-save-append`,
        ));
        const append_result = save_results(panel).find(
            (result) => result.lifecycle.operation.saveRequestId === `${prefix}-save-append`,
        )!;
        expect(append_result.success).toBe(true);
        const assignment = append_result.receipt!.appendedRows[0];

        const remove_session = await request_edit_session_when_available(
            panel,
            `${prefix}-remove-edit`,
        );
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                remove_session,
                `${prefix}-save-remove`,
                save_worksheet({
                    edits: {},
                    dirtyEdits: {},
                    structuralChanges: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [{
                            appendHistoryId: assignment.pendingRowId,
                            sourceRow: assignment.sourceRow,
                            savedFingerprint: assignment.savedFingerprint,
                            savedRow: assignment.savedRow!,
                        }],
                        conflicts: [],
                    },
                }),
            ),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle.operation.saveRequestId === `${prefix}-save-remove`,
        ));
        expect(save_results(panel).find(
            (result) => result.lifecycle.operation.saveRequestId === `${prefix}-save-remove`,
        )?.success).toBe(true);

        const restore_session = await request_edit_session_when_available(
            panel,
            `${prefix}-restore-edit`,
        );
        const source_generation = latest_snapshot(panel).sourceGeneration;
        const restore_request_id = `${prefix}-restore`;
        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: restore_request_id,
            editSessionId: restore_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: source_generation,
            appendHistoryIds: [assignment.pendingRowId],
        });
        const restoration = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'restoreSavedRowsResult'
            && (message as { requestId?: unknown }).requestId === restore_request_id
        )) as Extract<import('../types').HostMessage, { type: 'restoreSavedRowsResult' }>;
        expect(restoration.granted, restoration.reason).toBe(true);
        const format = assignment.savedRow!.format;
        const template = {
            id: `restored-format:${createHash('sha256')
                .update(JSON.stringify(format)).digest('hex')}`,
            format,
        };
        const row = {
            id: assignment.pendingRowId,
            cells: assignment.savedRow!.cells,
            formatTemplateId: template.id,
            createdOrder: Number.MAX_SAFE_INTEGER,
        };
        const desired = {
            formatTemplates: [template],
            appendedRows: [row],
            tailRemovals: [],
            appendBasis: restoration.appendBasis!,
            conflicts: [],
        };
        return {
            assignment,
            desired,
            restoreRequestId: restore_request_id,
            restoreSession: restore_session,
            sourceGeneration: source_generation,
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

    it('renames a promoted header through its canonical source coordinate', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'rename-header', {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                edits: { '0:1': 'Years' },
                dirtyEdits: { '0:1': { value: 'Years', base: 'Age' } },
            }),
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[0][1]?.raw).toBe('Years');
    });

    it('writes the same canonical name into the header and its structured formulas', async () => {
        const file = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const patched = Buffer.from(
            Buffer.from(sheet.content as Uint8Array).toString('utf8').replace(
                '<c r="C2" t="b"><v>1</v></c>',
                '<c r="C2"><f>SUM([Age])</f><v>55</v></c>',
            ),
            'utf8',
        );
        sheet.content = patched;
        sheet.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'canonical-header', {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                edits: { '0:1': '  Net\t Revenue  ' },
                dirtyEdits: { '0:1': { value: '  Net\t Revenue  ', base: 'Age' } },
            }),
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[0][1]?.raw).toBe('Net Revenue');
        expect(after.data.sheets[0].rows[1][2]?.formula).toBe('=SUM([Net Revenue])');
    });

    it('refuses to clear a promoted header through a malformed rename request', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const before = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'blank-header', {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                edits: { '0:1': '   ' },
                dirtyEdits: { '0:1': { value: '   ', base: 'Age' } },
            }),
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(bytes).toEqual(before);
    });

    it('refuses a duplicate promoted header from a malformed rename request', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const before = bytes;

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'duplicate-header', {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                edits: { '0:1': ' name ' },
                dirtyEdits: { '0:1': { value: ' name ', base: 'Age' } },
            }),
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: false });
        expect(bytes).toEqual(before);
    });

    it('uses fileReload semantics when a save changes automatic header projection', async () => {
        const panel = await open_ready_xlsx(file_path);
        const initial = latest_snapshot(panel);
        expect(initial.meta.sheets[0]).toMatchObject({
            rowCount: 2,
            excelFirstRowHeader: { active: true },
        });
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const edits = {
            '1:1': 'thirty',
            '1:2': 'yes',
            '1:3': 'unknown',
            '2:1': 'twenty-five',
            '2:2': 'no',
            '2:3': 'unknown',
        };
        const dirtyEdits = {
            '1:1': { value: 'thirty', base: '30' },
            '1:2': { value: 'yes', base: 'true' },
            '1:3': { value: 'unknown', base: '2024-01-15T00:00:00.000Z' },
            '2:1': { value: 'twenty-five', base: '25' },
            '2:2': { value: 'no', base: 'false' },
            '2:3': { value: 'unknown', base: '2023-06-01T00:00:00.000Z' },
        };

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'header-projection-change', {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                edits,
                dirtyEdits,
            }),
        });
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(source_refresh_snapshots(panel)).toHaveLength(1);
        expect(source_refresh_snapshots(panel)[0].reason).toBe('fileReload');
        expect(source_refresh_snapshots(panel)[0].meta.sheets[0]).toMatchObject({
            rowCount: 3,
            excelFirstRowHeader: { active: false },
        });
    });

    it('uses save semantics when the XLSX row projection stays stable', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'stable-header-projection', save_worksheet()),
        });
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        expect(source_refresh_snapshots(panel)).toHaveLength(1);
        expect(source_refresh_snapshots(panel)[0].reason).toBe('save');
        expect(source_refresh_snapshots(panel)[0].meta.sheets[0]).toMatchObject({
            rowCount: 2,
            excelFirstRowHeader: { active: true },
        });
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

    it('admits formula-shaped rich text under the writer\'s text rules', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const value = `=${'x'.repeat(8_193)}`;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-formula-shaped-rich-text',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: { '1:0': value },
                    dirtyEdits: {
                        '1:0': {
                            value,
                            base: 'Alice',
                            valueRuns: {
                                runs: [{ text: value, style: { bold: true } }],
                            },
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[1][0]).toMatchObject({ raw: value });
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

    it('retains ambiguous value membership without rewriting styled cell XML', async () => {
        const { before, before_cell, base_text, cell_xml_before } =
            await patch_styled_a2();

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-retained-value-link',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: {},
                    dirtyEdits: {
                        '1:0': {
                            value: base_text,
                            base: base_text,
                            link: { kind: 'external', target: 'https://example.com/retained' },
                            baseLink: null,
                            observedBase: {
                                value: base_text,
                                runs: before_cell.richText,
                                link: null,
                            },
                            retainValue: true,
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const cell_xml_after = cell_xml_a2(bytes);
        expect(cell_xml_after).toBe(cell_xml_before);
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[1][0]?.richText)
            .toEqual(before.data.sheets[0].rows[1][0]?.richText);
        expect(after.data.sheets[0].rows[1][0]?.hyperlink).toEqual({
            kind: 'external',
            target: 'https://example.com/retained',
        });
    });

    it('preserves styled cell XML after resolving an equal legacy scalar', async () => {
        const { before_cell, base_text, cell_xml_before } = await patch_styled_a2();

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'save-resolved-equal-rich-value',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: {},
                    dirtyEdits: {
                        '1:0': {
                            value: base_text,
                            base: base_text,
                            valueRuns: before_cell.richText,
                            baseRuns: before_cell.richText,
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({ success: true });
        const cell_xml_after = cell_xml_a2(bytes);
        expect(cell_xml_after).toBe(cell_xml_before);
        const after = await parse_xlsx(bytes);
        expect(after.data.sheets[0].rows[1][0]?.richText).toEqual(before_cell.richText);
    });

    it('rejects a stale equal-value write before it can replace newer formatting', async () => {
        const { before_cell, base_text, cell_xml_before } = await patch_styled_a2();
        const untouched = bytes;

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'x', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session,
                saveRequestId: 'reject-stale-equal-value-write',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'People',
                    worksheetId: '1',
                    edits: { '1:0': base_text },
                    dirtyEdits: {
                        '1:0': {
                            value: base_text,
                            base: base_text,
                            observedBase: { value: 'Different file text' },
                            writeValue: true,
                        },
                    },
                }],
            },
        });
        await wait_for_observable(() => save_results(panel).length > 0);

        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            rejection: {
                reason: 'baseMismatch',
                worksheetOperationIndex: 0,
                keys: ['1:0'],
                observedBases: {
                    '1:0': {
                        value: base_text,
                        runs: before_cell.richText,
                    },
                },
            },
        });
        expect(bytes).toBe(untouched);
        const cell_xml_after = cell_xml_a2(bytes);
        expect(cell_xml_after).toBe(cell_xml_before);
        expect((await parse_xlsx(bytes)).data.sheets[0].rows[1][0]?.richText)
            .toEqual(before_cell.richText);
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
        bytes = fs.readFileSync(path.join(
            __dirname,
            '..',
            '..',
            'docs',
            'examples',
            'garden-cafe-sample.xlsx',
        ));
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

    it('settles source-display lookups beyond the current worksheet extent', async () => {
        const panel = await open_ready_xlsx(file_path);
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestSourceDisplayRows',
            requestId: 'resolve-future-row',
            sheetIndex: 0,
            sourceRows: [1, 100],
            generation: snapshot.generation,
        });
        expect(panel.__messages).toContainEqual({
            type: 'sourceDisplayRows',
            requestId: 'resolve-future-row',
            sheetIndex: 0,
            sourceRows: [1, 100],
            displayRows: [0, null],
            generation: snapshot.generation,
            mappingGeneration: expect.any(Number),
        });
    });

    it('fingerprints only the style dependencies used by appended rows', async () => {
        const parsed = await parse_xlsx(bytes);
        const source_row_count = parsed.data.sheets[0].rows.length;
        const column_count = parsed.data.sheets[0].rows.reduce(
            (largest, row) => Math.max(largest, row.length),
            1,
        );
        const baseline = capture_xlsx_append_row_format(
            bytes,
            0,
            source_row_count,
            column_count,
        );
        const rewrite_styles = (transform: (xml: string) => string): Uint8Array => {
            const file = CFB.read(bytes, { type: 'buffer' });
            const entry = CFB.find(file, '/xl/styles.xml')!;
            const rewritten = Buffer.from(
                transform(Buffer.from(entry.content as Uint8Array).toString('utf8')),
                'utf8',
            );
            entry.content = rewritten;
            entry.size = rewritten.length;
            const written = CFB.write(file, {
                type: 'buffer',
                fileType: 'zip',
                compression: true,
            });
            return written instanceof Uint8Array
                ? written
                : new Uint8Array(written as ArrayBufferLike);
        };
        const unrelated = rewrite_styles((xml) => xml.replace(
            'defaultSlicerStyle="SlicerStyleLight1"',
            'defaultSlicerStyle="SlicerStyleDark1"',
        ));
        const referenced = rewrite_styles((xml) => xml.replace(
            '<color theme="1"/>',
            '<color theme="2"/>',
        ));

        expect(capture_xlsx_append_row_format(
            unrelated,
            0,
            source_row_count,
            column_count,
        ).styleFingerprint).toBe(baseline.styleFingerprint);
        expect(capture_xlsx_append_row_format(
            referenced,
            0,
            source_row_count,
            column_count,
        ).styleFingerprint).not.toBe(baseline.styleFingerprint);
    });

    it('does not bless a width shrink when a retained style dependency also changed', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-before-width-and-style-change',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'append-before-width-and-style-change'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        expect(admission.appendBasis?.provisionalRowCount).toBe(1);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-before-width-and-style-change',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        const file = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const sheet_before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const sheet_after = sheet_before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:C3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:3"')
            .replace(/<c r="D[123]"[^>]*>[\s\S]*?<\/c>/g, '');
        expect(sheet_after).not.toBe(sheet_before);
        sheet.content = Buffer.from(sheet_after, 'utf8');
        sheet.size = sheet.content.length;
        const styles = CFB.find(file, '/xl/styles.xml')!;
        const styles_before = Buffer.from(styles.content as Uint8Array).toString('utf8');
        const styles_after = styles_before.replace(
            '<color theme="1"/>',
            '<color theme="2"/>',
        );
        expect(styles_after).not.toBe(styles_before);
        styles.content = Buffer.from(styles_after, 'utf8');
        styles.size = styles.content.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);
        const reconciled = latest_snapshot(panel).state?.pendingEdits?.[0];
        expect(reconciled?.appendBasis?.columnCount).toBe(4);
        expect(reconciled?.conflicts).toContainEqual({
            reason: 'templateChanged',
            pendingRowIds: admission.rowIds,
            tailRemovalIds: [],
        });
    });

    it('rejects a delayed structural publication from before a source refresh', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const before_refresh = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-before-delayed-publication',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: before_refresh.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'append-before-delayed-publication'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-before-delayed-publication',
            editSessionId: session,
            accepted: true,
        });
        const delayed_changes = {
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            formatTemplates: [admission.formatTemplate!],
            appendedRows: [{
                id: admission.rowIds![0],
                cells: { 3: { value: 'stale-width', valueEditOrder: 1 } },
                formatTemplateId: admission.formatTemplate!.id,
                createdOrder: 1,
            }],
            tailRemovals: [],
            appendBasis: admission.appendBasis!,
            conflicts: [],
        };

        const file = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const after = before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:C3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:3"')
            .replace(/<c r="D[123]"[^>]*>[\s\S]*?<\/c>/g, '');
        sheet.content = Buffer.from(after, 'utf8');
        sheet.size = sheet.content.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => latest_snapshot(panel).meta.sheets[0].columnCount === 3);

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: before_refresh.sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: delayed_changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('fences a structural publication queued behind a blocked state write', async () => {
        const state = versioned_state_store({});
        const original_read = state.store.read.bind(state.store);
        let block_next_read = false;
        let blocked_read_entered = false;
        let release_read!: () => void;
        const blocked_read = new Promise<void>((resolve) => { release_read = resolve; });
        state.store.read = async (...args: Parameters<typeof original_read>) => {
            if (block_next_read) {
                block_next_read = false;
                blocked_read_entered = true;
                await blocked_read;
            }
            return original_read(...args);
        };
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;

        block_next_read = true;
        const blocking_write = panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session,
            sequence: 1,
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            edits: { '0:0': { value: 'queued first', base: 'Alice' } },
        });
        await wait_for_observable(() => blocked_read_entered);

        const before_refresh = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-behind-blocked-write',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: before_refresh.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'append-behind-blocked-write'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-behind-blocked-write',
            editSessionId: session,
            accepted: true,
        });
        const structural_write = panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: before_refresh.sourceGeneration,
            editSessionId: session,
            sequence: 2,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: { '0:0': { value: 'queued first', base: 'Alice' } },
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });

        const file = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const after = before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:C3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:3"')
            .replace(/<c r="D[123]"[^>]*>[\s\S]*?<\/c>/g, '');
        sheet.content = Buffer.from(after, 'utf8');
        sheet.size = sheet.content.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);
        const refresh = vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => latest_snapshot(panel).meta.sheets[0].columnCount === 3);

        release_read();
        await Promise.all([blocking_write, structural_write, refresh]);
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 2,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows ?? [])
            .toEqual([]);
    });

    it('does not let a repeated settlement overtake structural publication', async () => {
        const state = versioned_state_store({});
        const compare = state.store.compare_and_set.bind(state.store);
        let block_publication = false;
        let publication_entered = false;
        let release_publication!: () => void;
        const publication_gate = new Promise<void>((resolve) => {
            release_publication = resolve;
        });
        state.store.compare_and_set = async (...args) => {
            if (block_publication) {
                block_publication = false;
                publication_entered = true;
                await publication_gate;
            }
            return compare(...args);
        };
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'settled-once',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'settled-once'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'settled-once',
            editSessionId: session,
            accepted: true,
        });
        const row = {
            id: admission.rowIds![0],
            cells: {},
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        };
        block_publication = true;
        const publication = panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: snapshot.sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [row],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await wait_for_observable(() => publication_entered);
        const repeated_settlement = panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'settled-once',
            editSessionId: session,
            accepted: false,
        });

        release_publication();
        await Promise.all([publication, repeated_settlement]);
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows).toEqual([row]);
    });

    it('keeps append authority until an admitted publication settles during release', async () => {
        const state = versioned_state_store({});
        const compare = state.store.compare_and_set.bind(state.store);
        let publication_entered = false;
        let release_publication!: () => void;
        const publication_gate = new Promise<void>((resolve) => {
            release_publication = resolve;
        });
        let block_publication = false;
        state.store.compare_and_set = async (...args) => {
            if (block_publication) {
                block_publication = false;
                publication_entered = true;
                await publication_gate;
            }
            return compare(...args);
        };
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'publish-while-releasing',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'publish-while-releasing'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'publish-while-releasing',
            editSessionId: session,
            accepted: true,
        });
        const row = {
            id: admission.rowIds![0],
            cells: {},
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        };
        block_publication = true;
        const publication = panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: snapshot.sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [row],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await wait_for_observable(() => publication_entered);
        const releasing = panel.__receive({
            type: 'releaseEditSession',
            editSessionId: session,
        });

        release_publication();
        await Promise.all([publication, releasing]);
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows).toEqual([row]);

        await panel.__receive({ type: 'requestEditSession', requestId: 'restore', sheetIndex: 0 });
        const restored = latest_edit_session(panel) as ReturnType<typeof latest_edit_session> & {
            pendingChanges?: import('../types').WorksheetPendingChanges;
        };
        expect(restored.pendingChanges?.appendedRows).toEqual([row]);
    });

    it('revalidates append authority after an earlier publication drains before Save', async () => {
        const state = versioned_state_store({});
        const compare = state.store.compare_and_set.bind(state.store);
        let publication_entered = false;
        let release_publication!: () => void;
        const publication_gate = new Promise<void>((resolve) => {
            release_publication = resolve;
        });
        let block_publication = false;
        state.store.compare_and_set = async (...args) => {
            if (block_publication) {
                block_publication = false;
                publication_entered = true;
                await publication_gate;
            }
            return compare(...args);
        };
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'consumed-before-save',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'consumed-before-save'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'consumed-before-save',
            editSessionId: session,
            accepted: true,
        });
        const row = {
            id: admission.rowIds![0],
            cells: {},
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        };
        block_publication = true;
        const publication = panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: snapshot.sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: { '0:0': { value: 'queued first', base: 'Alice' } },
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
            },
        });
        await wait_for_observable(() => publication_entered);

        const bytes_before_save = bytes;
        const save_count = save_results(panel).length;
        const save = panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'save-consumed-admission', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: {
                    formatTemplates: [admission.formatTemplate!],
                    appendedRows: [row],
                    tailRemovals: [],
                    appendBasis: admission.appendBasis!,
                    conflicts: [],
                },
            })),
        });
        release_publication();
        await Promise.all([publication, save]);
        await wait_for_observable(() => save_results(panel).length > save_count);

        expect(save_results(panel).at(-1)?.success).toBe(false);
        expect(bytes).toBe(bytes_before_save);
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows ?? []).toEqual([]);
        expect(state.get_state(file_path).pendingEdits?.[0]?.cells).toEqual({
            '0:0': { value: 'queued first', base: 'Alice' },
        });
    });

    it('refuses redo of an undone append after the worksheet width changes', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-before-undo-and-shrink',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'append-before-undo-and-shrink'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-before-undo-and-shrink',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [{
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                appendHistoryIds: [],
                pendingRowIds: admission.rowIds!,
            }],
        });
        const appended = {
            formatTemplates: [admission.formatTemplate!],
            appendedRows: [{
                id: admission.rowIds![0],
                cells: { 3: { value: 'removed-column value', valueEditOrder: 1 } },
                formatTemplateId: admission.formatTemplate!.id,
                createdOrder: 1,
            }],
            tailRemovals: [],
            appendBasis: admission.appendBasis!,
            conflicts: [],
        };
        const empty = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                ...appended,
            },
        });
        await controller_of(panel).drain();

        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'undo-append-prepare',
                replayId: 'undo-append-replay',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: appended,
                    desired: empty,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 2,
                    sourceRowEnd: 2,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'undo-append-replay'
        )));
        const undo_prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'undo-append-replay'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;
        const compare = state.store.compare_and_set.bind(state.store);
        let replay_write_entered = false;
        let release_replay_write!: () => void;
        const replay_write_gate = new Promise<void>((resolve) => {
            release_replay_write = resolve;
        });
        let block_replay_write = true;
        state.store.compare_and_set = async (...args) => {
            if (block_replay_write) {
                block_replay_write = false;
                replay_write_entered = true;
                await replay_write_gate;
            }
            return compare(...args);
        };
        const undo_commit = panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: undo_prepared.prepared.requestId,
                replayId: undo_prepared.prepared.replayId,
                leaseId: undo_prepared.prepared.leaseId,
                mutationId: 'undo-append-mutation',
                cells: [],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        await wait_for_observable(() => replay_write_entered);
        const late_publication = panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: snapshot.sourceGeneration,
            editSessionId: session,
            sequence: 2,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                ...appended,
            },
        });
        release_replay_write();
        await Promise.all([undo_commit, late_publication]);
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayCommitted'
            && (message as { committed?: { replayId?: unknown } }).committed?.replayId
                === 'undo-append-replay'
        )));
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 2,
        });

        const file = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const sheet_before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const sheet_after = sheet_before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:C3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:3"')
            .replace(/<c r="D[123]"[^>]*>[\s\S]*?<\/c>/g, '');
        expect(sheet_after).not.toBe(sheet_before);
        sheet.content = Buffer.from(sheet_after, 'utf8');
        sheet.size = sheet.content.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => latest_snapshot(panel).meta.sheets[0].columnCount === 3);

        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'redo-append-prepare',
                replayId: 'redo-append-replay',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: empty,
                    desired: appended,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 2,
                    sourceRowEnd: 2,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepareRefused'
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'redo-append-replay'
        )));
        const refusal = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepareRefused'
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'redo-append-replay'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepareRefused' }>;
        expect(refusal.refusal.reason).toBe('conflict');
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('refuses redo when external growth captures a provisional formula coordinate', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-formula-band',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 2,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append-formula-band'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-formula-band',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [{
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                appendHistoryIds: [],
                pendingRowIds: admission.rowIds!,
            }],
        });
        const appended = {
            formatTemplates: [admission.formatTemplate!],
            appendedRows: [{
                id: admission.rowIds![0],
                cells: { 0: { value: 'pending target', valueEditOrder: 1 } },
                formatTemplateId: admission.formatTemplate!.id,
                createdOrder: 1,
            }, {
                id: admission.rowIds![1],
                cells: {
                    1: {
                        value: '=A4',
                        valueEditOrder: 2,
                        formulaReferenceBases: [{
                            targetSheetIndex: 0,
                            targetSheetName: 'People',
                            targetWorksheetId: '1',
                            provisionalStartRow: 3,
                            provisionalRowCount: 2,
                        }],
                    },
                },
                formatTemplateId: admission.formatTemplate!.id,
                createdOrder: 2,
            }],
            tailRemovals: [],
            appendBasis: admission.appendBasis!,
            conflicts: [],
        };
        const empty = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: snapshot.sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                ...appended,
            },
        });
        await controller_of(panel).drain();
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'undo-formula-band',
                replayId: 'undo-formula-band',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: appended,
                    desired: empty,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 3,
                    sourceRowEnd: 4,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 1,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'undo-formula-band'
        )));
        const prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'undo-formula-band'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;
        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: prepared.prepared.requestId,
                replayId: prepared.prepared.replayId,
                leaseId: prepared.prepared.leaseId,
                mutationId: 'undo-formula-band',
                cells: [],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayCommitted'
            && (message as { committed?: { replayId?: unknown } }).committed?.replayId
                === 'undo-formula-band'
        )));

        const grown = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(grown, '/xl/worksheets/sheet1.xml')!;
        const before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const after = before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:D4"/>')
            .replace('</sheetData>', '<row r="4"><c r="A4" t="inlineStr"><is><t>external</t></is></c></row></sheetData>');
        sheet.content = Buffer.from(after, 'utf8');
        sheet.size = sheet.content.length;
        const written = CFB.write(grown, {
            type: 'buffer', fileType: 'zip', compression: true,
        });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => latest_snapshot(panel).meta.sheets[0].sourceRowCount === 4);

        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'redo-formula-band',
                replayId: 'redo-formula-band',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: empty,
                    desired: appended,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 3,
                    sourceRowEnd: 4,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 1,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepareRefused'
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'redo-formula-band'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepareRefused',
            refusal: expect.objectContaining({
                replayId: 'redo-formula-band',
                reason: 'conflict',
            }),
        }));
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('marks pending rows conflicted after a style-only external change', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-before-style-only-change',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'append-before-style-only-change'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-before-style-only-change',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        const file = CFB.read(bytes, { type: 'buffer' });
        const styles = CFB.find(file, '/xl/styles.xml')!;
        const before = Buffer.from(styles.content as Uint8Array).toString('utf8');
        const after = before.replace('<color theme="1"/>', '<color theme="2"/>');
        expect(after).not.toBe(before);
        styles.content = Buffer.from(after, 'utf8');
        styles.size = styles.content.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);
        const reconciled = latest_snapshot(panel).state?.pendingEdits?.[0];
        expect(reconciled?.appendBasis).toEqual(admission.appendBasis);
        expect(reconciled?.conflicts).toContainEqual({
            reason: 'templateChanged',
            pendingRowIds: admission.rowIds,
            tailRemovalIds: [],
        });
    });

    it('keeps a many-row reconciliation conflict inside the reserved byte budget', async () => {
        const format = capture_xlsx_append_row_format(bytes, 0, 3, 4, 0);
        const template = { id: 'near-limit-template', format };
        const rows = Array.from({ length: 1_000 }, (_, index) => ({
            id: `near-limit-row-${index.toString().padStart(4, '0')}`,
            cells: {},
            formatTemplateId: template.id,
            createdOrder: index + 1,
        }));
        const basis = {
            sourceRowCount: 3,
            provisionalStartRow: 3,
            provisionalRowCount: rows.length,
            columnCount: 4,
            schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
                columnCount: 4,
                columnNames: ['Name', 'Age', 'Active', 'Joined'],
            })).digest('hex')}`,
            styleFingerprint: format.styleFingerprint,
        };
        const base_slot = {
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            formatTemplates: [template],
            appendedRows: rows,
            tailRemovals: [],
            appendBasis: basis,
            conflicts: [],
        };
        const base_bytes = Buffer.byteLength(JSON.stringify({
            sheetIndex: 0,
            ...base_slot,
        }), 'utf8');
        const filler_size = MAX_PENDING_USER_CHANGES_ENCODED_BYTES - base_bytes - 256;
        expect(filler_size).toBeGreaterThan(0);
        rows[0] = {
            ...rows[0],
            cells: { 0: { value: 'x'.repeat(filler_size), valueEditOrder: 1 } },
        };
        const near_limit_slot = { ...base_slot, appendedRows: rows };
        expect(Buffer.byteLength(JSON.stringify(near_limit_slot), 'utf8'))
            .toBeLessThanOrEqual(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);
        expect(Buffer.byteLength(JSON.stringify({
            ...near_limit_slot,
            conflicts: [{
                reason: 'templateChanged',
                pendingRowIds: rows.map((row) => row.id),
                tailRemovalIds: [],
            }],
        }), 'utf8')).toBeGreaterThan(MAX_PENDING_CHANGES_ENCODED_BYTES);

        const state = versioned_state_store({ pendingEdits: [near_limit_slot] });
        const panel = await open_ready_xlsx(file_path, state);
        const file = CFB.read(bytes, { type: 'buffer' });
        const styles = CFB.find(file, '/xl/styles.xml')!;
        const before = Buffer.from(styles.content as Uint8Array).toString('utf8');
        const after = before.replace('<color theme="1"/>', '<color theme="2"/>');
        expect(after).not.toBe(before);
        styles.content = Buffer.from(after, 'utf8');
        styles.size = styles.content.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);
        const reconciled = latest_snapshot(panel).state?.pendingEdits?.[0];
        expect(reconciled?.conflicts).toEqual([{
            reason: 'templateChanged',
            pendingRowIds: rows.slice(0, 16).map((row) => row.id),
            tailRemovalIds: [],
        }]);
        expect(Buffer.byteLength(JSON.stringify(reconciled), 'utf8'))
            .toBeLessThanOrEqual(MAX_PENDING_CHANGES_ENCODED_BYTES);
    });

    it('uses the conflict reserve when width reconciliation crosses the user cap', async () => {
        const format = capture_xlsx_append_row_format(bytes, 0, 3, 4, 0);
        const template = { id: 'gap-template', format };
        const basis = {
            sourceRowCount: 3,
            provisionalStartRow: 3,
            provisionalRowCount: 1,
            columnCount: 4,
            schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
                columnCount: 4,
                columnNames: ['Name', 'Age', 'Active', 'Joined'],
            })).digest('hex')}`,
            styleFingerprint: format.styleFingerprint,
        };
        const row = {
            id: 'gap-row',
            cells: { 0: { value: '', valueEditOrder: 1 } },
            formatTemplateId: template.id,
            createdOrder: 1,
        };
        const base_slot = {
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            formatTemplates: [template],
            appendedRows: [row],
            tailRemovals: [],
            appendBasis: basis,
            conflicts: [],
        };
        const base_bytes = Buffer.byteLength(JSON.stringify({
            sheetIndex: 0,
            ...base_slot,
        }), 'utf8');
        row.cells[0].value = 'x'.repeat(
            MAX_PENDING_USER_CHANGES_ENCODED_BYTES - base_bytes - 1,
        );
        const near_user_cap = { ...base_slot, appendedRows: [row] };
        expect(Buffer.byteLength(JSON.stringify({
            sheetIndex: 0,
            ...near_user_cap,
        }), 'utf8'))
            .toBeLessThanOrEqual(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);

        const state = versioned_state_store({ pendingEdits: [near_user_cap] });
        const panel = await open_ready_xlsx(file_path, state);
        const grown = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(grown, '/xl/worksheets/sheet1.xml')!;
        const before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const after = before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:E3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:5"')
            .replace(
                '<c r="D3" s="1"><v>45078</v></c>',
                '<c r="D3" s="1"><v>45078</v></c><c r="E3"><v>1</v></c>',
            );
        sheet.content = Buffer.from(after, 'utf8');
        sheet.size = sheet.content.length;
        const written = CFB.write(grown, {
            type: 'buffer', fileType: 'zip', compression: true,
        });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);

        const reconciled = latest_snapshot(panel).state?.pendingEdits?.[0];
        expect(reconciled?.appendBasis).toEqual(basis);
        expect(reconciled?.conflicts).toEqual([{
            reason: 'templateChanged',
            pendingRowIds: ['gap-row'],
            tailRemovalIds: [],
        }]);
        expect(Buffer.byteLength(JSON.stringify(reconciled), 'utf8'))
            .toBeLessThanOrEqual(MAX_PENDING_CHANGES_ENCODED_BYTES);
        const roundtrip = {
            sheetIndex: 0,
            ...reconciled!,
            tailRemovals: reconciled!.tailRemovals ?? [],
        };
        expect(Buffer.byteLength(JSON.stringify(roundtrip), 'utf8'))
            .toBeGreaterThan(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);
        expect(Buffer.byteLength(JSON.stringify(roundtrip), 'utf8'))
            .toBeLessThanOrEqual(MAX_PENDING_CHANGES_ENCODED_BYTES);
        expect(Buffer.byteLength(JSON.stringify({
            ...roundtrip,
            conflicts: [],
        }), 'utf8')).toBeLessThanOrEqual(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);

        const session = await request_edit_session_when_available(panel, 'conflict-roundtrip');
        expect(own_wire_pending_changes(roundtrip)).toBeDefined();
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: roundtrip,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        const save_count = save_results(panel).length;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                session,
                'save-host-conflict-in-reserve',
                save_worksheet({
                    edits: {},
                    dirtyEdits: {},
                    structuralChanges: {
                        formatTemplates: reconciled!.formatTemplates!,
                        appendedRows: reconciled!.appendedRows!,
                        tailRemovals: reconciled!.tailRemovals ?? [],
                        appendBasis: reconciled!.appendBasis!,
                        conflicts: reconciled!.conflicts!,
                    },
                }),
            ),
        });
        await wait_for_observable(() => save_results(panel).length > save_count);
        expect(save_results(panel).at(-1)).toMatchObject({
            success: false,
            rejection: {
                reason: 'structuralConflict',
                structuralReason: 'templateChanged',
            },
        });

        const bytes_before_stripped_save = bytes;
        const stripped_save_count = save_results(panel).length;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                session,
                'save-with-stripped-host-conflict',
                save_worksheet({
                    edits: {},
                    dirtyEdits: {},
                    structuralChanges: {
                        formatTemplates: reconciled!.formatTemplates!,
                        appendedRows: reconciled!.appendedRows!,
                        tailRemovals: reconciled!.tailRemovals ?? [],
                        appendBasis: reconciled!.appendBasis!,
                        conflicts: [],
                    },
                }),
            ),
        });
        await wait_for_observable(() => save_results(panel).length > stripped_save_count);
        expect(save_results(panel).at(-1)?.success).toBe(false);
        expect(bytes).toBe(bytes_before_stripped_save);
        expect(state.get_state(file_path).pendingEdits?.[0]?.conflicts).toEqual(
            reconciled?.conflicts,
        );
    });

    it('drops style dependencies belonging only to a removed blank column', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-before-shrink',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append-before-shrink'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.formatTemplate?.format).toMatchObject({
            cellStyleIndexes: [null, null, null, 1],
        });
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-before-shrink',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        const file = CFB.read(bytes, { type: 'buffer' });
        const sheet = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
        const sheet_before = Buffer.from(sheet.content as Uint8Array).toString('utf8');
        const sheet_after = sheet_before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:C3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:3"')
            .replace(/<c r="D[123]"[^>]*>[\s\S]*?<\/c>/g, '');
        expect(sheet_after).not.toBe(sheet_before);
        sheet.content = Buffer.from(sheet_after, 'utf8');
        sheet.size = sheet.content.length;
        const styles = CFB.find(file, '/xl/styles.xml')!;
        const styles_before = Buffer.from(styles.content as Uint8Array).toString('utf8');
        const styles_after = styles_before.replace(
            '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
            '<xf numFmtId="15" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
        );
        expect(styles_after).not.toBe(styles_before);
        styles.content = Buffer.from(styles_after, 'utf8');
        styles.size = styles.content.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);
        const reconciled = latest_snapshot(panel).state?.pendingEdits?.[0];
        expect(reconciled?.appendBasis?.columnCount).toBe(3);
        expect(reconciled?.formatTemplates?.[0]?.format).toMatchObject({
            cellStyleIndexes: [null, null, null],
        });
        expect(reconciled?.appendBasis?.styleFingerprint).toBe(
            reconciled?.formatTemplates?.[0]?.format.kind === 'xlsx'
                ? reconciled.formatTemplates[0].format.styleFingerprint
                : undefined,
        );
        expect(reconciled?.conflicts ?? []).toEqual([]);
    });

    it('uses the row-style display recipe for columns added after admission', async () => {
        const styled = CFB.read(bytes, { type: 'buffer' });
        const styled_sheet = CFB.find(styled, '/xl/worksheets/sheet1.xml')!;
        const styled_before = Buffer.from(styled_sheet.content as Uint8Array).toString('utf8');
        const styled_after = styled_before.replace(
            '<row r="3" spans="1:4" x14ac:dyDescent="0.25">',
            '<row r="3" spans="1:4" x14ac:dyDescent="0.25" s="1" customFormat="1">',
        ).replace('<c r="A3"', '<c r="A3" s="0"');
        expect(styled_after).not.toBe(styled_before);
        styled_sheet.content = Buffer.from(styled_after, 'utf8');
        styled_sheet.size = styled_sheet.content.length;
        const styled_bytes = CFB.write(styled, {
            type: 'buffer', fileType: 'zip', compression: true,
        });
        bytes = styled_bytes instanceof Uint8Array
            ? styled_bytes
            : new Uint8Array(styled_bytes as ArrayBufferLike);

        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-before-row-style-growth',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'append-before-row-style-growth'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.formatTemplate?.format).toMatchObject({
            rowStyleIndex: 1,
            rowNumberFormat: { code: 'm/d/yy' },
            rowFontStyle: { bold: false, italic: false },
        });
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-before-row-style-growth',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        const grown = CFB.read(bytes, { type: 'buffer' });
        const grown_sheet = CFB.find(grown, '/xl/worksheets/sheet1.xml')!;
        const grown_before = Buffer.from(grown_sheet.content as Uint8Array).toString('utf8');
        const grown_after = grown_before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:E3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:5"')
            .replace(
                '<c r="D3" s="1"><v>45078</v></c>',
                '<c r="D3" s="1"><v>45078</v></c><c r="E3"><v>1</v></c>',
            );
        expect(grown_after).not.toBe(grown_before);
        grown_sheet.content = Buffer.from(grown_after, 'utf8');
        grown_sheet.size = grown_sheet.content.length;
        const grown_bytes = CFB.write(grown, {
            type: 'buffer', fileType: 'zip', compression: true,
        });
        bytes = grown_bytes instanceof Uint8Array
            ? grown_bytes
            : new Uint8Array(grown_bytes as ArrayBufferLike);

        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);
        const reconciled = latest_snapshot(panel).state?.pendingEdits?.[0];
        expect(reconciled?.appendBasis?.columnCount).toBe(5);
        expect(reconciled?.formatTemplates?.[0]?.format).toMatchObject({
            cellStyleIndexes: [0, null, null, 1, null],
            cellNumberFormats: [
                null,
                { code: 'm/d/yy' },
                { code: 'm/d/yy' },
                { code: 'm/d/yy' },
                { code: 'm/d/yy' },
            ],
            cellFontStyles: [
                { bold: false, italic: false },
                { bold: false, italic: false },
                { bold: false, italic: false },
                { bold: false, italic: false },
                { bold: false, italic: false },
            ],
        });
        expect(reconciled?.conflicts ?? []).toEqual([]);
    });

    it('conflicts instead of expanding a row display recipe past the pending byte bound', async () => {
        const long_number_format = '0'.repeat(32_767);
        const styled = CFB.read(bytes, { type: 'buffer' });
        const styles = CFB.find(styled, '/xl/styles.xml')!;
        const styles_before = Buffer.from(styles.content as Uint8Array).toString('utf8');
        const styles_after = styles_before
            .replace(
                '<fonts count="1"',
                `<numFmts count="1"><numFmt numFmtId="164" formatCode="${long_number_format}"/></numFmts><fonts count="1"`,
            )
            .replace(
                '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
                '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
            );
        expect(styles_after).not.toBe(styles_before);
        styles.content = Buffer.from(styles_after, 'utf8');
        styles.size = styles.content.length;
        const styled_sheet = CFB.find(styled, '/xl/worksheets/sheet1.xml')!;
        const sheet_before = Buffer.from(styled_sheet.content as Uint8Array).toString('utf8');
        const sheet_after = sheet_before.replace(
            '<row r="3" spans="1:4" x14ac:dyDescent="0.25">',
            '<row r="3" spans="1:4" x14ac:dyDescent="0.25" s="1" customFormat="1">',
        ).replace('<c r="A3"', '<c r="A3" s="0"');
        expect(sheet_after).not.toBe(sheet_before);
        styled_sheet.content = Buffer.from(sheet_after, 'utf8');
        styled_sheet.size = styled_sheet.content.length;
        const styled_bytes = CFB.write(styled, {
            type: 'buffer', fileType: 'zip', compression: true,
        });
        bytes = styled_bytes instanceof Uint8Array
            ? styled_bytes
            : new Uint8Array(styled_bytes as ArrayBufferLike);

        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-before-extreme-growth',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'append-before-extreme-growth'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        expect(admission.formatTemplate?.format).toMatchObject({
            rowNumberFormat: { code: long_number_format },
        });
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-before-extreme-growth',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        const grown = CFB.read(bytes, { type: 'buffer' });
        const grown_sheet = CFB.find(grown, '/xl/worksheets/sheet1.xml')!;
        const grown_before = Buffer.from(grown_sheet.content as Uint8Array).toString('utf8');
        const grown_after = grown_before
            .replace('<dimension ref="A1:D3"/>', '<dimension ref="A1:IV3"/>')
            .replace(/ spans="1:4"/g, ' spans="1:256"')
            .replace(
                '<c r="D3" s="1"><v>45078</v></c>',
                '<c r="D3" s="1"><v>45078</v></c><c r="IV3"><v>1</v></c>',
            );
        expect(grown_after).not.toBe(grown_before);
        grown_sheet.content = Buffer.from(grown_after, 'utf8');
        grown_sheet.size = grown_sheet.content.length;
        const grown_bytes = CFB.write(grown, {
            type: 'buffer', fileType: 'zip', compression: true,
        });
        bytes = grown_bytes instanceof Uint8Array
            ? grown_bytes
            : new Uint8Array(grown_bytes as ArrayBufferLike);
        expect((await parse_xlsx(bytes)).data.sheets[0].columnCount).toBe(256);
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength,
            mtime: 2,
        }));

        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await controller_of(panel).drain();
        await wait_for_observable(() => source_refresh_snapshots(panel).length > 0);
        const reconciled = latest_snapshot(panel).state?.pendingEdits?.[0];
        expect(reconciled?.appendBasis).toEqual(admission.appendBasis);
        expect(reconciled?.formatTemplates).toEqual([admission.formatTemplate]);
        expect(reconciled?.conflicts).toContainEqual({
            reason: 'templateChanged',
            pendingRowIds: admission.rowIds,
            tailRemovalIds: [],
        });
    });

    it('releases a refused maximum-size append reservation immediately', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        const request = async (requestId: string, count: number) => {
            await panel.__receive({
                type: 'requestAppendRows',
                requestId,
                editSessionId: session,
                worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                sourceGeneration: snapshot.sourceGeneration,
                count,
            });
            return panel.__messages.find((message) => (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'appendRowsResult'
                && (message as { requestId?: unknown }).requestId === requestId
            )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        };

        const refused_locally = await request('maximum-reservation', 10_000);
        expect(refused_locally.granted, refused_locally.reason).toBe(true);
        expect(refused_locally.rowIds).toHaveLength(10_000);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'maximum-reservation',
            editSessionId: session,
            accepted: false,
        });

        const current = await request('after-cancel', 1);
        expect(current.granted, current.reason).toBe(true);
        expect(current.rowIds).toHaveLength(1);
        expect(current.appendBasis?.provisionalRowCount).toBe(1);
        expect(current.appendBasis?.provisionalStartRow)
            .toBe(refused_locally.appendBasis?.provisionalStartRow);
        expect(current.formatTemplate?.id).not.toBe(refused_locally.formatTemplate?.id);
    });

    it('cancels an undelivered admission when the receiver reloads', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'first', sheetIndex: 0 });
        const first_session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'stale-admission',
            editSessionId: first_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const stale = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'stale-admission'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(stale.granted, stale.reason).toBe(true);

        const prior_snapshots = panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'workbookSnapshot'
        )).length;
        await panel.__receive({ type: 'ready' });
        await wait_for_observable(() => panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'workbookSnapshot'
        )).length > prior_snapshots);
        await panel.__receive({ type: 'requestEditSession', requestId: 'second', sheetIndex: 0 });
        const second_session = latest_edit_session(panel)!.editSessionId!;
        const reloaded = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'fresh-admission',
            editSessionId: second_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: reloaded.sourceGeneration,
            count: 1,
        });
        const fresh = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'fresh-admission'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(fresh.granted, fresh.reason).toBe(true);
        expect(fresh.appendBasis?.provisionalRowCount).toBe(1);
    });

    it('builds append receipts from canonical cells parsed from the saved XLSX', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-canonical',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 2,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append-canonical'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        expect(admission.appendBasis?.provisionalRowCount).toBe(2);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-canonical',
            editSessionId: session,
            accepted: true,
        });
        const rich = { runs: [{ text: 'Rich', style: { bold: true } }] };
        const formula_reference_bases = [{
            targetSheetIndex: 0,
            targetSheetName: 'People',
            targetWorksheetId: '1',
            provisionalStartRow: 3,
            provisionalRowCount: 2,
        }];
        const input_rows = [{
            id: admission.rowIds![0],
            cells: {
                0: { value: '1.0', valueEditOrder: 1 },
                1: { value: 'TRUE', valueEditOrder: 1 },
                2: { value: '=1+1', valueEditOrder: 1 },
                3: { value: '2024-01-01', valueEditOrder: 1 },
            },
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        }, {
            id: admission.rowIds![1],
            cells: {
                0: { value: 'Rich', valueRuns: rich, valueEditOrder: 2 },
                1: {
                    value: 'site',
                    link: { kind: 'external' as const, target: 'HTTPS://Example.COM/a/../b' },
                    valueEditOrder: 2,
                },
                2: {
                    value: '=A4',
                    valueEditOrder: 2,
                    formulaReferenceBases: formula_reference_bases,
                },
            },
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 2,
        }];
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'save-canonical-append', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: {
                    formatTemplates: [admission.formatTemplate!],
                    appendedRows: input_rows,
                    tailRemovals: [],
                    appendBasis: admission.appendBasis!,
                    conflicts: [],
                },
            })),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle.operation.saveRequestId === 'save-canonical-append',
        ));

        const result = save_results(panel).find(
            (candidate) => candidate.lifecycle.operation.saveRequestId === 'save-canonical-append',
        )!;
        expect(result.success).toBe(true);
        expect(result.receipt?.appendedRows).toHaveLength(2);
        const parsed = await parse_xlsx(bytes);
        for (const assignment of result.receipt!.appendedRows) {
            const persisted = parsed.data.sheets[0].rows[assignment.sourceRow];
            expect(assignment.savedCells).toBeDefined();
            for (const [column_text, cell] of Object.entries(assignment.savedCells!)) {
                const persisted_cell = persisted[Number(column_text)]!;
                expect(cell.value).toBe(persisted_cell.formula ?? String(persisted_cell.raw ?? ''));
                expect(cell.valueRuns).toEqual(persisted_cell.richText);
                expect(cell.link).toEqual(persisted_cell.hyperlink);
            }
        }
        expect(result.receipt!.appendedRows[0].savedCells![0].value).not.toBe('1.0');
        expect(result.receipt!.appendedRows[1].savedCells![0].valueRuns).toEqual(rich);
        expect(result.receipt!.appendedRows[1].savedCells![1].link).toEqual({
            kind: 'external',
            target: 'https://example.com/b',
        });
        expect(result.receipt!.appendedRows[1].savedRow?.cells[2].formulaReferenceBases)
            .toEqual(formula_reference_bases);
    });

    it('recalculates workbook formula caches for a completely blank append', async () => {
        const file = CFB.read(bytes, { type: 'buffer' });
        const formula_sheet = CFB.find(file, '/xl/worksheets/sheet2.xml')!;
        const formula_xml = Buffer.from(formula_sheet.content as Uint8Array).toString('utf8')
            .replace('<c r="C2"><v>100</v></c>', '<c r="C2"><f>1+1</f><v>99</v></c>');
        expect(formula_xml).toContain('<c r="C2"><f>1+1</f><v>99</v></c>');
        formula_sheet.content = Buffer.from(formula_xml, 'utf8');
        formula_sheet.size = formula_sheet.content.length;
        const patched = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        bytes = patched instanceof Uint8Array
            ? patched
            : new Uint8Array(patched as ArrayBufferLike);

        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-blank',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append-blank'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-blank',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'save-blank-append', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: {
                    formatTemplates: [admission.formatTemplate!],
                    appendedRows: [{
                        id: admission.rowIds![0],
                        cells: {},
                        formatTemplateId: admission.formatTemplate!.id,
                        createdOrder: 1,
                    }],
                    tailRemovals: [],
                    appendBasis: admission.appendBasis!,
                    conflicts: [],
                },
            })),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle.operation.saveRequestId === 'save-blank-append',
        ));

        expect(save_results(panel).find(
            (result) => result.lifecycle.operation.saveRequestId === 'save-blank-append',
        )?.success).toBe(true);
        const saved_formula_xml = read_part(bytes, 'xl/worksheets/sheet2.xml')!.toString('utf8');
        expect(saved_formula_xml).toContain('<c r="C2"><f>1+1</f></c>');
        expect(saved_formula_xml).not.toContain('<f>1+1</f><v>99</v>');
    });

    it('returns a structured rejection with every affected structural identity', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-conflicted',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append-conflicted'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-conflicted',
            editSessionId: session,
            accepted: true,
        });
        const untouched = bytes;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'save-conflicted-append', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: {
                    formatTemplates: [admission.formatTemplate!],
                    appendedRows: [{
                        id: admission.rowIds![0],
                        cells: {},
                        formatTemplateId: admission.formatTemplate!.id,
                        createdOrder: 1,
                    }],
                    tailRemovals: [],
                    appendBasis: admission.appendBasis!,
                    conflicts: [{
                        reason: 'rowLimitExceeded',
                        pendingRowIds: admission.rowIds!,
                        tailRemovalIds: [],
                    }],
                },
            })),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle.operation.saveRequestId === 'save-conflicted-append',
        ));

        expect(save_results(panel).find(
            (result) => result.lifecycle.operation.saveRequestId === 'save-conflicted-append',
        )).toMatchObject({
            success: false,
            rejection: {
                reason: 'structuralConflict',
                worksheetOperationIndex: 0,
                structuralReason: 'rowLimitExceeded',
                pendingRowIds: admission.rowIds,
                tailRemovalIds: [],
            },
        });
        expect(bytes).toBe(untouched);
    });

    it('round-trips complete admitted row basis through durable publication', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        expect(state.get_state(file_path).pendingEdits?.[0]).toMatchObject({
            appendBasis: admission.appendBasis,
            conflicts: [],
        });

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 2,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: {
                    ...admission.appendBasis!,
                    sourceRowCount: admission.appendBasis!.sourceRowCount + 1,
                },
                conflicts: [],
            },
        });
        await controller_of(panel).drain();
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendBasis)
            .toEqual(admission.appendBasis);
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingEditsAcknowledged',
            editSessionId: session,
            sequence: 2,
        });

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 3,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [{
                    appendHistoryId: 'forged-history',
                    sourceRow: snapshot.meta.sheets[0].sourceRowCount - 1,
                    savedFingerprint: 'forged-fingerprint',
                    savedRow: { cells: {}, format: { kind: 'none' } },
                }],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();
        expect(state.get_state(file_path).pendingEdits?.[0]?.tailRemovals).toEqual([]);
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingEditsAcknowledged',
            editSessionId: session,
            sequence: 3,
        });

        await panel.__receive({ type: 'releaseEditSession', editSessionId: session });
        await panel.__receive({ type: 'requestEditSession', requestId: 'restore', sheetIndex: 0 });
        const restored = latest_edit_session(panel) as typeof admission & {
            pendingChanges?: import('../types').WorksheetPendingChanges;
        };
        expect(restored.pendingChanges).toMatchObject({
            appendBasis: admission.appendBasis,
            // Reconciliation proved the blank row's formula mapping unambiguous,
            // so the stale formula-only conflict is resolved on restoration.
            conflicts: [],
        });
    });

    it('binds every admitted row identity to the exact format template it was granted', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const request_append = async (requestId: string) => {
            const snapshot = latest_snapshot(panel);
            await panel.__receive({
                type: 'requestAppendRows',
                requestId,
                editSessionId: session,
                worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                sourceGeneration: snapshot.sourceGeneration,
                count: 1,
            });
            return panel.__messages.find((message) => (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'appendRowsResult'
                && (message as { requestId?: unknown }).requestId === requestId
            )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        };
        const first = await request_append('first-format');
        expect(first.granted, first.reason).toBe(true);
        expect(first.appendBasis?.provisionalRowCount).toBe(1);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'first-format',
            editSessionId: session,
            accepted: true,
        });

        const before_resize = latest_snapshot(panel);
        await panel.__receive({
            type: 'setRowHeights',
            sheetIndex: 0,
            rows: [{ start: 1, end: 1 }],
            height: 44,
            generation: before_resize.generation,
            sourceGeneration: before_resize.sourceGeneration,
        });
        await wait_for_observable(() => state.get_state(file_path).rowHeights?.[0]?.[2] === 44);
        const second = await request_append('second-format');
        expect(second.granted, second.reason).toBe(true);
        expect(second.appendBasis?.provisionalRowCount).toBe(2);
        expect(second.formatTemplate!.id).not.toBe(first.formatTemplate!.id);
        expect(second.formatTemplate?.format).toMatchObject({ viewerRowHeight: 44 });
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'second-format',
            editSessionId: session,
            accepted: true,
        });

        const rows = [{
            id: first.rowIds![0],
            cells: {},
            formatTemplateId: second.formatTemplate!.id,
            createdOrder: 1,
        }, {
            id: second.rowIds![0],
            cells: {},
            formatTemplateId: first.formatTemplate!.id,
            createdOrder: 2,
        }];
        const changes = {
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            formatTemplates: [first.formatTemplate!, second.formatTemplate!],
            appendedRows: rows,
            tailRemovals: [],
            appendBasis: second.appendBasis!,
            conflicts: [],
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        const valid_changes = {
            ...changes,
            appendedRows: [{
                ...rows[0],
                formatTemplateId: first.formatTemplate!.id,
            }, {
                ...rows[1],
                formatTemplateId: second.formatTemplate!.id,
            }],
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: valid_changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                session,
                'save-inherited-viewer-height',
                save_worksheet({
                    edits: {},
                    dirtyEdits: {},
                    structuralChanges: valid_changes,
                }),
            ),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle?.operation.saveRequestId
                === 'save-inherited-viewer-height',
        ));
        const result = save_results(panel).find(
            (candidate) => candidate.lifecycle?.operation.saveRequestId
                === 'save-inherited-viewer-height',
        );
        expect(result?.success).toBe(true);
        expect(result?.receipt?.appendedRows.find(
            (row) => row.pendingRowId === second.rowIds?.[0],
        )?.savedRow).toMatchObject({
            viewerRowHeight: 44,
            format: { viewerRowHeight: 44 },
        });
    });

    it('uses one canonical append ledger across equivalent worksheet target spellings', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'name-only-grant',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'name-only-grant'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'name-only-grant',
            editSessionId: session,
            accepted: true,
        });

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: {},
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
    });

    it('rejects a live row-admission request identity reused on another worksheet', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const source_generation = latest_snapshot(panel).sourceGeneration;
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'same-request',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: source_generation,
            count: 1,
        });
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'same-request',
            editSessionId: session,
            worksheet: { sheetIndex: 1, sheetName: 'Inventory', worksheetId: '2' },
            sourceGeneration: source_generation,
            count: 1,
        });
        const results = panel.__messages.filter((message): message is Extract<
            import('../types').HostMessage,
            { type: 'appendRowsResult' }
        > => typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'same-request');
        expect(results).toHaveLength(2);
        expect(results[0].granted).toBe(true);
        expect(results[1]).toMatchObject({ granted: false });
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'same-request',
            editSessionId: session,
            accepted: false,
        });
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'fresh-inventory-request',
            editSessionId: session,
            worksheet: { sheetIndex: 1, sheetName: 'Inventory', worksheetId: '2' },
            sourceGeneration: source_generation,
            count: 1,
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'appendRowsResult',
            requestId: 'fresh-inventory-request',
            granted: true,
        }));
    });

    it('rejects a partial publication of one accepted row-admission batch', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'two-row-batch',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 2,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'two-row-batch'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'two-row-batch',
            editSessionId: session,
            accepted: true,
        });
        const rows = admission.rowIds!.map((id, index) => ({
            id,
            cells: {},
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: index + 1,
        }));
        const changes = {
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            formatTemplates: [admission.formatTemplate!],
            appendedRows: rows,
            tailRemovals: [],
            appendBasis: admission.appendBasis!,
            conflicts: [],
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: { ...changes, appendedRows: [rows[0]] },
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows).toEqual(rows);
    });

    it('rejects partial Save and replay of one accepted row-admission gesture', async () => {
        const state = versioned_state_store({});
        const untouched = bytes;
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'two-row-direct-consumer',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 2,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'two-row-direct-consumer'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'two-row-direct-consumer',
            editSessionId: session,
            accepted: true,
        });
        const partial = {
            formatTemplates: [admission.formatTemplate!],
            appendedRows: [{
                id: admission.rowIds![0],
                cells: {},
                formatTemplateId: admission.formatTemplate!.id,
                createdOrder: 1,
            }],
            tailRemovals: [],
            appendBasis: admission.appendBasis!,
            conflicts: [],
        };

        const save_count = save_results(panel).length;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'partial-direct-save', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: partial,
            })),
        });
        await wait_for_observable(() => save_results(panel).length > save_count);
        expect(save_results(panel).at(-1)?.success).toBe(false);
        expect(bytes).toBe(untouched);

        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'partial-direct-replay-prepare',
                replayId: 'partial-direct-replay',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    desired: partial,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: snapshot.meta.sheets[0].sourceRowCount - 1,
                    sourceRowEnd: snapshot.meta.sheets[0].sourceRowCount - 1,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepareRefused'
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'partial-direct-replay'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepareRefused',
            refusal: expect.objectContaining({
                replayId: 'partial-direct-replay',
                reason: 'conflict',
            }),
        }));
    });

    it('rejects a structural replay that forges a host-owned conflict', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const empty = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        };

        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'forged-conflict-prepare',
                replayId: 'forged-conflict-replay',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: empty,
                    desired: {
                        ...empty,
                        conflicts: [{
                            reason: 'templateChanged',
                            pendingRowIds: [],
                            tailRemovalIds: [],
                        }],
                    },
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 0,
                    sourceRowEnd: 0,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'forged-conflict-replay'
        )));
        const prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'forged-conflict-replay'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;
        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: prepared.prepared.requestId,
                replayId: prepared.prepared.replayId,
                leaseId: prepared.prepared.leaseId,
                mutationId: 'forged-conflict-mutation',
                cells: [],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayCommitRefused'
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'forged-conflict-replay'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayCommitRefused',
            refusal: expect.objectContaining({
                replayId: 'forged-conflict-replay',
                reason: 'conflict',
            }),
        }));
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('keeps the conflict reserve unavailable to replayed row content', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'near-cap-replay-admission',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'near-cap-replay-admission'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        expect(admission.granted, admission.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'near-cap-replay-admission',
            editSessionId: session,
            accepted: true,
        });

        const row = {
            id: admission.rowIds![0],
            cells: { 0: { value: '', valueEditOrder: 1 } },
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        };
        const desired = {
            formatTemplates: [admission.formatTemplate!],
            appendedRows: [row],
            tailRemovals: [],
            appendBasis: admission.appendBasis!,
            conflicts: [],
        };
        const wire_target = {
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            ...desired,
        };
        const base_bytes = Buffer.byteLength(JSON.stringify(wire_target), 'utf8');
        row.cells[0].value = 'x'.repeat(
            MAX_PENDING_USER_CHANGES_ENCODED_BYTES - base_bytes + 1,
        );
        expect(Buffer.byteLength(JSON.stringify(wire_target), 'utf8'))
            .toBeGreaterThan(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);
        expect(Buffer.byteLength(JSON.stringify(wire_target), 'utf8'))
            .toBeLessThanOrEqual(MAX_PENDING_CHANGES_ENCODED_BYTES);

        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'near-cap-replay-prepare',
                replayId: 'near-cap-replay',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    desired,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: snapshot.meta.sheets[0].sourceRowCount,
                    sourceRowEnd: snapshot.meta.sheets[0].sourceRowCount,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (
                (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                    === 'near-cap-replay'
                || (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                    === 'near-cap-replay'
            )
        )));
        const prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'near-cap-replay'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }> | undefined;
        expect(prepared, JSON.stringify(panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'near-cap-replay'
        )))).toBeDefined();
        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: prepared!.prepared.requestId,
                replayId: prepared!.prepared.replayId,
                leaseId: prepared!.prepared.leaseId,
                mutationId: 'near-cap-replay-mutation',
                cells: [],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayCommitRefused'
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'near-cap-replay'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayCommitRefused',
            refusal: expect.objectContaining({
                replayId: 'near-cap-replay',
                reason: 'conflict',
            }),
        }));
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('rejects duplicate resolved replay coordinates before materializing source content', async () => {
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const target = { sheetIndex: 0, sheetName: 'People', worksheetId: '1' };
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'duplicate-coordinate-prepare',
                replayId: 'duplicate-coordinate-replay',
                cells: [0, 1].map((ordinal) => ({
                    ordinal,
                    worksheet: target,
                    sourceRow: 1,
                    sourceColumn: 0,
                    overlay: { kind: 'absent' as const },
                })),
                highlights: [],
                focus: {
                    worksheet: target,
                    sourceRowStart: 1,
                    sourceRowEnd: 1,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'duplicate-coordinate-replay'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepareRefused',
            refusal: expect.objectContaining({
                replayId: 'duplicate-coordinate-replay',
                reason: 'malformed',
            }),
        }));
        expect(panel.__messages).not.toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepared',
            prepared: expect.objectContaining({ replayId: 'duplicate-coordinate-replay' }),
        }));
    });

    it('bounds source-content amplification in the exact prepared response', async () => {
        const cell_count = 10_000;
        bytes = build_repeated_shared_string_xlsx(
            cell_count,
            'x'.repeat(32_767),
        );
        const panel = await open_ready_xlsx(file_path);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const snapshot = latest_snapshot(panel);
        const sheet = snapshot.meta.sheets[0];
        expect(sheet.sourceRowCount).toBe(cell_count);
        const target = {
            sheetIndex: 0,
            sheetName: sheet.name,
            ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
        };
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'prepared-amplification-prepare',
                replayId: 'prepared-amplification-replay',
                cells: Array.from({ length: cell_count }, (_, ordinal) => ({
                    ordinal,
                    worksheet: target,
                    sourceRow: ordinal,
                    sourceColumn: 0,
                    overlay: { kind: 'absent' as const },
                })),
                highlights: [],
                focus: {
                    worksheet: target,
                    sourceRowStart: 0,
                    sourceRowEnd: cell_count - 1,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'prepared-amplification-replay'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepareRefused',
            refusal: expect.objectContaining({
                replayId: 'prepared-amplification-replay',
                reason: 'unavailable',
            }),
        }));
        expect(panel.__messages).not.toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepared',
            prepared: expect.objectContaining({ replayId: 'prepared-amplification-replay' }),
        }));
    }, 30_000);

    it('refuses an oversized combined replay terminal before changing durable state', async () => {
        const sheet_count = 34;
        bytes = build_many_sheet_xlsx(sheet_count);
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        expect(snapshot.meta.sheets).toHaveLength(sheet_count);

        const current_structures: PendingStructuralChanges[] = [];
        const targets: WorksheetTarget[] = [];
        for (let sheet_index = 0; sheet_index < sheet_count; sheet_index += 1) {
            const sheet = snapshot.meta.sheets[sheet_index];
            const target = {
                sheetIndex: sheet_index,
                sheetName: sheet.name,
                ...(sheet.worksheetId === undefined
                    ? {}
                    : { worksheetId: sheet.worksheetId }),
            };
            targets.push(target);
            const request_id = `terminal-bound-admission-${sheet_index}`;
            await panel.__receive({
                type: 'requestAppendRows',
                requestId: request_id,
                editSessionId: session,
                worksheet: target,
                sourceGeneration: snapshot.sourceGeneration,
                count: 1,
            });
            const admission = panel.__messages.find((message) => (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'appendRowsResult'
                && (message as { requestId?: unknown }).requestId === request_id
            )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
            expect(admission.granted, admission.reason).toBe(true);
            await panel.__receive({
                type: 'settleRowAdmission',
                requestId: request_id,
                editSessionId: session,
                accepted: true,
            });
            const current = {
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [{
                    id: admission.rowIds![0],
                    cells: { 0: { value: 'seed' } },
                    formatTemplateId: admission.formatTemplate!.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            };
            current_structures.push(current);
            await panel.__receive({
                type: 'pendingChangesChanged',
                sourceGeneration: snapshot.sourceGeneration,
                editSessionId: session,
                sequence: sheet_index + 1,
                changes: {
                    ...target,
                    cells: {},
                    ...current,
                },
            });
        }
        await controller_of(panel).drain();

        // Reused deliberately: the byte measurer must count every logical
        // occurrence while scanning the shared string's UTF-8 only once.
        const large = 'x'.repeat(4_050_000);
        const desired_structures = current_structures.map((current) => ({
            ...current,
            appendedRows: [{
                ...current.appendedRows[0],
                cells: { 0: { value: large } },
            }],
        }));
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'terminal-bound-prepare',
                replayId: 'terminal-bound-replay',
                cells: targets.map((worksheet, ordinal) => ({
                    ordinal,
                    worksheet,
                    sourceRow: 0,
                    sourceColumn: 0,
                    overlay: { kind: 'absent' as const },
                })),
                highlights: [],
                structures: targets.map((worksheet, ordinal) => ({
                    ordinal,
                    worksheet,
                    expected: current_structures[ordinal],
                    desired: desired_structures[ordinal],
                })),
                focus: {
                    worksheet: targets[0],
                    sourceRowStart: 0,
                    sourceRowEnd: 0,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'terminal-bound-replay'
        )));
        const prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'terminal-bound-replay'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;

        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: prepared.prepared.requestId,
                replayId: prepared.prepared.replayId,
                leaseId: prepared.prepared.leaseId,
                mutationId: 'terminal-bound-mutation',
                cells: targets.map((_target, ordinal) => ({
                    ordinal,
                    entry: { value: large, base: 'base' },
                })),
                highlights: [],
                structures: targets.map((_target, ordinal) => ({ ordinal })),
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'terminal-bound-replay'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayCommitRefused',
            refusal: expect.objectContaining({
                replayId: 'terminal-bound-replay',
                reason: 'unavailable',
            }),
        }));
        const durable = state.get_state(file_path).pendingEdits;
        expect(durable).toHaveLength(sheet_count);
        for (let sheet_index = 0; sheet_index < sheet_count; sheet_index += 1) {
            expect(durable?.[sheet_index]?.cells).toEqual({});
            expect(durable?.[sheet_index]?.appendedRows?.[0].cells[0]?.value).toBe('seed');
        }
    }, 30_000);

    it('recomputes a resolved formula conflict across Undo and Redo', async () => {
        const format = capture_xlsx_append_row_format(bytes, 0, 3, 4, 0);
        const template = { id: 'formula-replay-template', format };
        const row = {
            id: 'formula-replay-row',
            cells: {},
            formatTemplateId: template.id,
            createdOrder: 1,
        };
        const basis = {
            sourceRowCount: 2,
            provisionalStartRow: 2,
            provisionalRowCount: 1,
            columnCount: 4,
            schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
                columnCount: 4,
                columnNames: ['Name', 'Age', 'Active', 'Joined'],
            })).digest('hex')}`,
            styleFingerprint: format.styleFingerprint,
        };
        const resolved_entry = { value: 'resolved', base: 'Alice', valueEditOrder: 2 };
        const formula_reference_bases = [{
            targetSheetIndex: 0,
            targetSheetName: 'People',
            targetWorksheetId: '1',
            provisionalStartRow: 2,
            provisionalRowCount: 1,
        }];
        const formula_entry = {
            value: '=A3',
            base: 'Alice',
            valueEditOrder: 1,
            formulaReferenceBases: formula_reference_bases,
        };
        const clean_structural = {
            formatTemplates: [template],
            appendedRows: [row],
            tailRemovals: [],
            appendBasis: basis,
            conflicts: [],
        };
        const conflicted_structural = {
            ...clean_structural,
            conflicts: [{
                reason: 'ambiguousPendingFormula',
                pendingRowIds: [],
                tailRemovalIds: [],
                formulaCells: [{
                    rowIdentity: { kind: 'source', sourceRow: 1 },
                    sourceColumn: 0,
                }],
            }],
        };
        const state = versioned_state_store({ pendingEdits: [{
            sheetName: 'People',
            worksheetId: '1',
            cells: { '1:0': resolved_entry },
            ...clean_structural,
        }] });
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        expect(latest_edit_session(panel)?.granted).toBe(true);

        const resolved_overlay = {
            kind: 'present',
            value: {
                kind: 'present',
                value: { text: resolved_entry.value },
                base: { text: resolved_entry.base },
                basePending: false,
                valueEditOrder: resolved_entry.valueEditOrder,
            },
            hyperlink: { kind: 'untouched' },
        };
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'restore-formula-conflict-prepare',
                replayId: 'restore-formula-conflict',
                cells: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRow: 1,
                    sourceColumn: 0,
                    overlay: resolved_overlay,
                }],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: clean_structural,
                    desired: conflicted_structural,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 1,
                    sourceRowEnd: 1,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (
                (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                    === 'restore-formula-conflict'
                || (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                    === 'restore-formula-conflict'
            )
        )));
        const undo_prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'restore-formula-conflict'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }> | undefined;
        expect(undo_prepared, JSON.stringify(panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'restore-formula-conflict'
        )))).toBeDefined();
        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: undo_prepared!.prepared.requestId,
                replayId: undo_prepared!.prepared.replayId,
                leaseId: undo_prepared!.prepared.leaseId,
                mutationId: 'restore-formula-conflict-mutation',
                cells: [{ ordinal: 0, entry: formula_entry }],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayCommitted'
            && (message as { committed?: { replayId?: unknown } }).committed?.replayId
                === 'restore-formula-conflict'
        )));
        expect(state.get_state(file_path).pendingEdits?.[0]).toMatchObject({
            cells: { '1:0': formula_entry },
            conflicts: conflicted_structural.conflicts,
        });

        const formula_overlay = {
            kind: 'present',
            value: {
                kind: 'present',
                value: { text: formula_entry.value },
                base: { text: formula_entry.base },
                basePending: false,
                valueEditOrder: formula_entry.valueEditOrder,
                formulaReferenceBases: formula_reference_bases,
            },
            hyperlink: { kind: 'untouched' },
        };
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'resolve-formula-conflict-prepare',
                replayId: 'resolve-formula-conflict',
                cells: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRow: 1,
                    sourceColumn: 0,
                    overlay: formula_overlay,
                }],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: conflicted_structural,
                    desired: clean_structural,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 1,
                    sourceRowEnd: 1,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'resolve-formula-conflict'
        )));
        const redo_prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'resolve-formula-conflict'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;
        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: redo_prepared.prepared.requestId,
                replayId: redo_prepared.prepared.replayId,
                leaseId: redo_prepared.prepared.leaseId,
                mutationId: 'resolve-formula-conflict-mutation',
                cells: [{ ordinal: 0, entry: resolved_entry }],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayCommitted'
            && (message as { committed?: { replayId?: unknown } }).committed?.replayId
                === 'resolve-formula-conflict'
        )));
        expect(state.get_state(file_path).pendingEdits?.[0]).toMatchObject({
            cells: { '1:0': resolved_entry },
            conflicts: [],
        });
    });

    it('commits host-derived cross-sheet formula conflicts across append Undo and Redo', async () => {
        const format = capture_xlsx_append_row_format(bytes, 1, 3, 3, 0);
        const template = { id: 'inventory-replay-template', format };
        const row = {
            id: 'inventory-replay-row',
            cells: {},
            formatTemplateId: template.id,
            createdOrder: 1,
        };
        const basis = {
            sourceRowCount: 2,
            provisionalStartRow: 2,
            provisionalRowCount: 1,
            columnCount: 3,
            schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
                columnCount: 3,
                columnNames: ['Product', 'Price', 'Quantity'],
            })).digest('hex')}`,
            styleFingerprint: format.styleFingerprint,
        };
        const appended = {
            formatTemplates: [template],
            appendedRows: [row],
            tailRemovals: [],
            appendBasis: basis,
            conflicts: [],
        };
        const empty = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        };
        const formula_entry = {
            value: "='Inventory'!A3",
            base: 'Alice',
            valueEditOrder: 1,
            formulaReferenceBases: [{
                targetSheetIndex: 1,
                targetSheetName: 'Inventory',
                targetWorksheetId: '2',
                provisionalStartRow: 2,
                provisionalRowCount: 1,
            }],
        };
        const formula_conflict = {
            reason: 'ambiguousPendingFormula',
            pendingRowIds: [],
            tailRemovalIds: [],
            formulaCells: [{
                rowIdentity: { kind: 'source', sourceRow: 1 },
                sourceColumn: 0,
            }],
        };
        const state = versioned_state_store({ pendingEdits: [{
            sheetName: 'People',
            worksheetId: '1',
            cells: { '1:0': formula_entry },
            ...empty,
        }, {
            sheetName: 'Inventory',
            worksheetId: '2',
            cells: {},
            ...appended,
        }] });
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 1 });
        expect(latest_edit_session(panel)?.granted).toBe(true);

        const replay_structure = async (
            replay_id: string,
            expected: typeof appended | typeof empty,
            desired: typeof appended | typeof empty,
        ) => {
            await panel.__receive({
                type: 'prepareHistoryReplay',
                request: {
                    requestId: `${replay_id}-prepare`,
                    replayId: replay_id,
                    cells: [],
                    highlights: [],
                    structures: [{
                        ordinal: 0,
                        worksheet: {
                            sheetIndex: 1,
                            sheetName: 'Inventory',
                            worksheetId: '2',
                        },
                        expected,
                        desired,
                    }],
                    focus: {
                        worksheet: {
                            sheetIndex: 1,
                            sheetName: 'Inventory',
                            worksheetId: '2',
                        },
                        sourceRowStart: 2,
                        sourceRowEnd: 2,
                        sourceColumnStart: 0,
                        sourceColumnEnd: 0,
                    },
                },
            });
            await wait_for_observable(() => panel.__messages.some((message) => (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'historyReplayPrepared'
                && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                    === replay_id
            )));
            const prepared = panel.__messages.find((message) => (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'historyReplayPrepared'
                && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                    === replay_id
            )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;
            await panel.__receive({
                type: 'commitHistoryReplay',
                request: {
                    requestId: prepared.prepared.requestId,
                    replayId: prepared.prepared.replayId,
                    leaseId: prepared.prepared.leaseId,
                    mutationId: `${replay_id}-mutation`,
                    cells: [],
                    highlights: [],
                    structures: [{ ordinal: 0 }],
                },
            });
            await wait_for_observable(() => panel.__messages.some((message) => (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'historyReplayCommitted'
                && (message as { committed?: { replayId?: unknown } }).committed?.replayId
                    === replay_id
            )));
            return panel.__messages.find((message) => (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'historyReplayCommitted'
                && (message as { committed?: { replayId?: unknown } }).committed?.replayId
                    === replay_id
            )) as Extract<import('../types').HostMessage, { type: 'historyReplayCommitted' }>;
        };

        const undone = await replay_structure('undo-cross-sheet-append', appended, empty);
        expect(undone.committed.structures).toContainEqual({
            ordinal: 1,
            resolvedSheetIndex: 0,
            expectedConflicts: [formula_conflict],
            desiredConflicts: [],
            hostDerived: true,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.cells)
            .toEqual({ '1:0': formula_entry });
        expect(state.get_state(file_path).pendingEdits?.[0]?.conflicts ?? []).toEqual([]);
        expect(state.get_state(file_path).pendingEdits?.[1]).toBeUndefined();

        const redone = await replay_structure('redo-cross-sheet-append', empty, appended);
        expect(redone.committed.structures).toContainEqual({
            ordinal: 1,
            resolvedSheetIndex: 0,
            expectedConflicts: [],
            desiredConflicts: [formula_conflict],
            hostDerived: true,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]).toMatchObject({
            cells: { '1:0': formula_entry },
            conflicts: [formula_conflict],
        });
        expect(state.get_state(file_path).pendingEdits?.[1]?.appendedRows).toEqual([row]);
    });

    it('strips an omitted accepted admission basis while preserving dirty cells', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'accepted-then-omitted',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'accepted-then-omitted'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'accepted-then-omitted',
            editSessionId: session,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: snapshot.sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: { '0:0': { value: 'edited', base: 'Alice' } },
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();

        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]).toEqual(expect.objectContaining({
            cells: { '0:0': { value: 'edited', base: 'Alice' } },
            appendedRows: [],
        }));
        expect(state.get_state(file_path).pendingEdits?.[0]).not.toHaveProperty('appendBasis');
    });

    it('rejects publication and save before an append admission is settled', async () => {
        const state = versioned_state_store({});
        const untouched = bytes;
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit', sheetIndex: 0 });
        const session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'unsettled-append',
            editSessionId: session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'unsettled-append'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        const row = {
            id: admission.rowIds![0],
            cells: {},
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        };
        const changes = {
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            formatTemplates: [admission.formatTemplate!],
            appendedRows: [row],
            tailRemovals: [],
            appendBasis: admission.appendBasis!,
            conflicts: [],
        };

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        const save_result_count = save_results(panel).length;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(session, 'save-unsettled-append', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: changes,
            })),
        });
        await wait_for_observable(() => save_results(panel).length > save_result_count);
        expect(save_results(panel).at(-1)?.success).toBe(false);
        expect(bytes).toBe(untouched);

        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'unsettled-append',
            editSessionId: session,
            accepted: false,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: session,
            sequence: 1,
            changes,
        });
        await controller_of(panel).drain();
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('releases restoration reservations when an unspent replay lease expires', async () => {
        const panel = await open_ready_xlsx(file_path, versioned_state_store({}));
        const restoration = await prepare_saved_row_restoration(panel, 'expired-lease');
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'expired-lease-prepare',
                replayId: 'expired-lease-replay',
                rowAdmissionRequestIds: [restoration.restoreRequestId],
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    desired: restoration.desired,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 2,
                    sourceRowEnd: 2,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'expired-lease-replay'
        )));
        const prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'expired-lease-replay'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(
            Date.now() + HISTORY_REPLAY_LEASE_TTL_MS,
        );
        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: prepared.prepared.requestId,
                replayId: prepared.prepared.replayId,
                leaseId: prepared.prepared.leaseId,
                mutationId: 'expired-lease-mutation',
                cells: [],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        clock.mockRestore();
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayCommitRefused',
            refusal: expect.objectContaining({
                replayId: 'expired-lease-replay',
                reason: 'expired',
            }),
        }));

        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: restoration.restoreRequestId,
            editSessionId: restoration.restoreSession,
            accepted: false,
        });
        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: 'expired-lease-restore-retry',
            editSessionId: restoration.restoreSession,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            appendHistoryIds: [restoration.assignment.pendingRowId],
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'restoreSavedRowsResult',
            requestId: 'expired-lease-restore-retry',
            granted: true,
        }));
    });

    it('cancels restoration reservations when source adoption invalidates a lease', async () => {
        const panel = await open_ready_xlsx(file_path, versioned_state_store({}));
        const restoration = await prepare_saved_row_restoration(panel, 'invalidated-lease');
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'invalidated-lease-prepare',
                replayId: 'invalidated-lease-replay',
                rowAdmissionRequestIds: [restoration.restoreRequestId],
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    desired: restoration.desired,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 2,
                    sourceRowEnd: 2,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'invalidated-lease-replay'
        )));

        bytes = rewrite_workbook_xml(bytes, (xml) =>
            xml.replace('name="Inventory"', 'name="Stock"'));
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel).includes('Stock'));

        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: 'invalidated-lease-restore-retry',
            editSessionId: restoration.restoreSession,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            appendHistoryIds: [restoration.assignment.pendingRowId],
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'restoreSavedRowsResult',
            requestId: 'invalidated-lease-restore-retry',
            granted: true,
        }));
    });

    it('cancels restoration reservations when replay preparation delivery fails', async () => {
        const panel = await open_ready_xlsx(file_path, versioned_state_store({}));
        const restoration = await prepare_saved_row_restoration(panel, 'undelivered-lease');
        const post_message = panel.webview.postMessage.bind(panel.webview);
        let delivery_entered = false;
        let release_delivery!: () => void;
        const delivery_gate = new Promise<void>((resolve) => {
            release_delivery = resolve;
        });
        panel.webview.postMessage = async (message: unknown) => {
            if (
                typeof message === 'object'
                && message !== null
                && (message as { type?: unknown }).type === 'historyReplayPrepared'
            ) {
                delivery_entered = true;
                await delivery_gate;
                return false;
            }
            return post_message(message);
        };
        const preparing = panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'undelivered-lease-prepare',
                replayId: 'undelivered-lease-replay',
                rowAdmissionRequestIds: [restoration.restoreRequestId],
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    desired: restoration.desired,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 2,
                    sourceRowEnd: 2,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => delivery_entered);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(
            Date.now() + HISTORY_REPLAY_LEASE_TTL_MS,
        );
        release_delivery();
        await preparing;
        clock.mockRestore();
        panel.webview.postMessage = post_message;
        expect(panel.__messages).not.toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepared',
            prepared: expect.objectContaining({ replayId: 'undelivered-lease-replay' }),
        }));

        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: 'undelivered-lease-restore-retry',
            editSessionId: restoration.restoreSession,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            appendHistoryIds: [restoration.assignment.pendingRowId],
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'restoreSavedRowsResult',
            requestId: 'undelivered-lease-restore-retry',
            granted: true,
        }));
    });

    it('keeps saved-row authority while its worksheet is temporarily absent', async () => {
        const panel = await open_ready_xlsx(file_path, versioned_state_store({}));
        const restoration = await prepare_saved_row_restoration(panel, 'missing-sheet');
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: restoration.restoreRequestId,
            editSessionId: restoration.restoreSession,
            accepted: false,
        });
        await panel.__receive({
            type: 'requestEditSession',
            requestId: 'missing-sheet-visit-inventory',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
        });
        expect(latest_edit_session(panel)?.editSessionId).toBe(restoration.restoreSession);
        await panel.__receive({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [{
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                appendHistoryIds: [restoration.assignment.pendingRowId],
                pendingRowIds: [],
            }],
        });

        const complete_workbook = bytes;
        bytes = drop_first_sheet(bytes);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => !sheet_names(panel).includes('People'));
        await panel.__receive({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [],
        });

        bytes = swap_sheet_order(complete_workbook);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await wait_for_observable(() => sheet_names(panel)[1] === 'People');
        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: 'missing-sheet-restore-retry',
            editSessionId: restoration.restoreSession,
            // The history target still carries People's old index. Its stable
            // worksheet ID is authoritative after the sheet returns at index 1.
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            appendHistoryIds: [restoration.assignment.pendingRowId],
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'restoreSavedRowsResult',
            requestId: 'missing-sheet-restore-retry',
            granted: true,
        }));
    });

    it('rejects a partial publication of one accepted saved-row restoration batch', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'append-edit', sheetIndex: 0 });
        const append_session = latest_edit_session(panel)!.editSessionId!;
        const initial = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-two-for-restore',
            editSessionId: append_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: initial.sourceGeneration,
            count: 2,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append-two-for-restore'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-two-for-restore',
            editSessionId: append_session,
            accepted: true,
        });
        const original_rows = admission.rowIds!.map((id, index) => ({
            id,
            cells: { 0: { value: `saved-${index}`, valueEditOrder: index + 1 } },
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: index + 1,
        }));
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(append_session, 'save-two-for-restore', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: {
                    formatTemplates: [admission.formatTemplate!],
                    appendedRows: original_rows,
                    tailRemovals: [],
                    appendBasis: admission.appendBasis!,
                    conflicts: [],
                },
            })),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle.operation.saveRequestId === 'save-two-for-restore',
        ));
        const append_result = save_results(panel).find(
            (result) => result.lifecycle.operation.saveRequestId === 'save-two-for-restore',
        )!;
        expect(append_result.success).toBe(true);
        const assignments = append_result.receipt!.appendedRows;
        expect(assignments).toHaveLength(2);

        const remove_session = await request_edit_session_when_available(panel, 'remove-edit');
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(remove_session, 'remove-two-for-restore', save_worksheet({
                edits: {},
                dirtyEdits: {},
                structuralChanges: {
                    formatTemplates: [],
                    appendedRows: [],
                    tailRemovals: assignments.map((assignment) => ({
                        appendHistoryId: assignment.pendingRowId,
                        sourceRow: assignment.sourceRow,
                        savedFingerprint: assignment.savedFingerprint,
                        savedRow: assignment.savedRow!,
                    })),
                    conflicts: [],
                },
            })),
        });
        await wait_for_observable(() => save_results(panel).some(
            (result) => result.lifecycle.operation.saveRequestId === 'remove-two-for-restore',
        ));
        expect(save_results(panel).find(
            (result) => result.lifecycle.operation.saveRequestId === 'remove-two-for-restore',
        )?.success).toBe(true);

        const restore_session = await request_edit_session_when_available(panel, 'restore-edit');
        const restored_source = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: 'restore-two-row-batch',
            editSessionId: restore_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: restored_source.sourceGeneration,
            appendHistoryIds: admission.rowIds!,
        });
        const restoration = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'restoreSavedRowsResult'
            && (message as { requestId?: unknown }).requestId === 'restore-two-row-batch'
        )) as Extract<import('../types').HostMessage, { type: 'restoreSavedRowsResult' }>;
        expect(restoration.granted, restoration.reason).toBe(true);
        const basis_only = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            appendBasis: restoration.appendBasis!,
            conflicts: [],
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: restore_session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                ...basis_only,
            },
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: restore_session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        const basis_save_count = save_results(panel).length;
        await panel.__receive({
            type: 'saveCsv',
            operation: workbook_request(
                restore_session,
                'save-unsettled-restoration-basis',
                save_worksheet({
                    edits: {},
                    dirtyEdits: {},
                    structuralChanges: basis_only,
                }),
            ),
        });
        await wait_for_observable(() => save_results(panel).length > basis_save_count);
        expect(save_results(panel).at(-1)?.success).toBe(false);

        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'replay-unsettled-restoration-basis',
                replayId: 'replay-unsettled-restoration-basis',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    desired: basis_only,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 2,
                    sourceRowEnd: 2,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepareRefused'
            && (message as { refusal?: { replayId?: unknown } }).refusal?.replayId
                === 'replay-unsettled-restoration-basis'
        )));
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'historyReplayPrepareRefused',
            refusal: expect.objectContaining({
                replayId: 'replay-unsettled-restoration-basis',
                reason: 'conflict',
            }),
        }));
        const restored_templates = assignments.map((assignment) => {
            const format = assignment.savedRow!.format;
            return {
                id: `restored-format:${createHash('sha256')
                    .update(JSON.stringify(format)).digest('hex')}`,
                format,
            };
        });
        const restored_rows = assignments.map((assignment, index) => ({
            id: assignment.pendingRowId,
            cells: assignment.savedRow!.cells,
            formatTemplateId: restored_templates[index].id,
            createdOrder: index + 1,
        }));
        const changes = {
            sheetIndex: 0,
            sheetName: 'People',
            worksheetId: '1',
            cells: {},
            formatTemplates: restored_templates,
            appendedRows: restored_rows,
            tailRemovals: [],
            appendBasis: restoration.appendBasis!,
            conflicts: [],
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: restore_session,
            sequence: 1,
            changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: restore_session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'restore-two-row-batch',
            editSessionId: restore_session,
            accepted: false,
        });

        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: 'restore-two-row-batch-retry',
            editSessionId: restore_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: restored_source.sourceGeneration,
            appendHistoryIds: admission.rowIds!,
        });
        const retry = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'restoreSavedRowsResult'
            && (message as { requestId?: unknown }).requestId === 'restore-two-row-batch-retry'
        )) as Extract<import('../types').HostMessage, { type: 'restoreSavedRowsResult' }>;
        expect(retry.granted, retry.reason).toBe(true);
        const accepted_changes = { ...changes, appendBasis: retry.appendBasis! };
        await panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'mixed-restoration-prepare',
                replayId: 'mixed-restoration-replay',
                rowAdmissionRequestIds: ['restore-two-row-batch-retry'],
                cells: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRow: 0,
                    sourceColumn: 0,
                    overlay: { kind: 'absent' },
                }],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    expected: {
                        formatTemplates: [],
                        appendedRows: [],
                        tailRemovals: [],
                        conflicts: [],
                    },
                    desired: accepted_changes,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
                    sourceRowStart: 0,
                    sourceRowEnd: 0,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'mixed-restoration-replay'
        )));
        const mixed_prepared = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: unknown } }).prepared?.replayId
                === 'mixed-restoration-replay'
        )) as Extract<import('../types').HostMessage, { type: 'historyReplayPrepared' }>;
        await panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: mixed_prepared.prepared.requestId,
                replayId: mixed_prepared.prepared.replayId,
                leaseId: mixed_prepared.prepared.leaseId,
                mutationId: 'mixed-restoration-mutation',
                cells: [{ ordinal: 0, entry: null }],
                highlights: [],
                structures: [{ ordinal: 0 }],
            },
        });
        await wait_for_observable(() => panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'historyReplayCommitted'
            && (message as { committed?: { replayId?: unknown } }).committed?.replayId
                === 'mixed-restoration-replay'
        )));
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows)
            .toEqual(restored_rows);
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: restore_session,
            sequence: 1,
            changes: { ...accepted_changes, appendedRows: [restored_rows[0]] },
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: restore_session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows)
            .toEqual(restored_rows);

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: restore_session,
            sequence: 1,
            changes: accepted_changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: restore_session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows)
            .toEqual(restored_rows);

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: restore_session,
            sequence: 2,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
            },
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: restore_session,
            sequence: 2,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        await panel.__receive({
            type: 'requestRestoreSavedRows',
            requestId: 'restore-two-row-batch-again',
            editSessionId: restore_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            appendHistoryIds: admission.rowIds!,
        });
        const repeated = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'restoreSavedRowsResult'
            && (message as { requestId?: unknown }).requestId
                === 'restore-two-row-batch-again'
        )) as Extract<import('../types').HostMessage, { type: 'restoreSavedRowsResult' }>;
        expect(repeated.granted, repeated.reason).toBe(true);
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'restore-two-row-batch-again',
            editSessionId: restore_session,
            accepted: true,
        });
        const repeated_changes = {
            ...accepted_changes,
            appendBasis: repeated.appendBasis!,
        };
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: restore_session,
            sequence: 3,
            changes: { ...repeated_changes, appendedRows: [restored_rows[0]] },
        });
        await controller_of(panel).drain();
        expect(panel.__messages).not.toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: restore_session,
            sequence: 3,
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: restore_session,
            sequence: 3,
            changes: repeated_changes,
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: restore_session,
            sequence: 3,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows)
            .toEqual(restored_rows);
    });

    it('readmits an unsaved pending row retained only by history in a new session', async () => {
        const state = versioned_state_store({});
        const panel = await open_ready_xlsx(file_path, state);
        await panel.__receive({ type: 'requestEditSession', requestId: 'first', sheetIndex: 0 });
        const first_session = latest_edit_session(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'append-for-history',
            editSessionId: first_session,
            worksheet: { sheetIndex: 0, sheetName: 'People', worksheetId: '1' },
            sourceGeneration: snapshot.sourceGeneration,
            count: 1,
        });
        const admission = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'appendRowsResult'
            && (message as { requestId?: unknown }).requestId === 'append-for-history'
        )) as Extract<import('../types').HostMessage, { type: 'appendRowsResult' }>;
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'append-for-history',
            editSessionId: first_session,
            accepted: true,
        });
        const row = {
            id: admission.rowIds![0],
            cells: { 0: { value: 'restored by undo', valueEditOrder: 2 } },
            formatTemplateId: admission.formatTemplate!.id,
            createdOrder: 1,
        };
        await panel.__receive({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [{
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                appendHistoryIds: [],
                pendingRowIds: [row.id],
            }],
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: first_session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
            },
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: first_session,
            sequence: 1,
        });
        await panel.__receive({ type: 'releaseEditSession', editSessionId: first_session });
        await panel.__receive({ type: 'requestEditSession', requestId: 'second', sheetIndex: 0 });
        const second_session = latest_edit_session(panel)!.editSessionId!;
        expect(second_session).not.toBe(first_session);

        await panel.__receive({
            type: 'pendingChangesChanged',
            sourceGeneration: latest_snapshot(panel).sourceGeneration,
            editSessionId: second_session,
            sequence: 1,
            changes: {
                sheetIndex: 0,
                sheetName: 'People',
                worksheetId: '1',
                cells: {},
                formatTemplates: [admission.formatTemplate!],
                appendedRows: [row],
                tailRemovals: [],
                appendBasis: admission.appendBasis!,
                conflicts: [],
            },
        });
        await controller_of(panel).drain();
        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: second_session,
            sequence: 1,
        });
        expect(state.get_state(file_path).pendingEdits?.[0]?.appendedRows)
            .toEqual([row]);
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
